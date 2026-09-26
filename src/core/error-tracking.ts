import { buildErrorEvent } from '../capture/build-error-event.js';
import { getSdkRuntime } from './client-ref.js';
import { getErrorTrackingConfig } from './error-tracking-config.js';
import { mergeEventContext } from './request-context.js';
import { safeRun } from './safe-run.js';
import { getTraceSpanState } from './trace-span-context.js';

/**
 * Error Tracking automatico, no modelo do Datadog: cada excecao registrada num span e candidata; quando a
 * raiz local (requisicao HTTP ou `withTrace`) termina, sai UM evento — o do span mais alto ("only the
 * top-most error is kept", docs do Datadog). Spec: docs/superpowers/specs/2026-09-25-sdk-3-error-tracking-design.md
 * (no monorepo).
 *
 * Tudo aqui e fail-open: um erro do SDK nunca chega a app.
 */

export const ERROR_TRACKING_CAPTURED_BY = 'error-tracking';
const MAX_PENDING_ROOTS = 1_000;
const MAX_CLOSED_ROOTS = 1_000;
const PENDING_TTL_MS = 10 * 60_000;

type Candidate = {
  error: Error;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  depth: number;
  context: Record<string, unknown> | undefined;
};

type RootErrors = {
  createdAt: number;
  best?: Candidate;
  boundary?: { error: Error; context: Record<string, unknown> | undefined };
};

/** Erros ja enviados. WeakSet e nao marca no objeto: o erro e do app, pode estar congelado. */
let capturedErrors = new WeakSet<object>();
const pending = new Map<string, RootErrors>();
/** Raizes ja fechadas (LRU pela ordem de insercao): erro que chega depois sai na hora. */
const closed = new Map<string, true>();

export function resetErrorTrackingState(): void {
  capturedErrors = new WeakSet<object>();
  pending.clear();
  closed.clear();
}

function rootKey(traceId: string, rootSpanId: string): string {
  return `${traceId}:${rootSpanId}`;
}

/** Raiz local do contexto ativo: o trace e o PRIMEIRO span da pilha. */
function currentRoot(): { traceId: string; rootSpanId: string } | undefined {
  const state = getTraceSpanState();
  const rootSpanId = state?.spanStack[0];
  return state !== undefined && rootSpanId !== undefined ? { traceId: state.traceId, rootSpanId } : undefined;
}

export function markErrorCaptured(error: unknown): void {
  if (typeof error === 'object' && error !== null) capturedErrors.add(error);
}

export function isErrorCaptured(error: unknown): boolean {
  return typeof error === 'object' && error !== null && capturedErrors.has(error);
}

function traceBlock(traceId: string, spanId: string, parentSpanId: string | null | undefined): Record<string, unknown> {
  return {
    trace_id: traceId,
    span_id: spanId,
    ...(parentSpanId !== null && parentSpanId !== undefined ? { parent_span_id: parentSpanId } : {}),
  };
}

function contextFor(traceId: string, spanId: string, parentSpanId: string | null): Record<string, unknown> {
  return {
    ...(mergeEventContext() ?? {}),
    trace: traceBlock(traceId, spanId, parentSpanId),
    captured_by: ERROR_TRACKING_CAPTURED_BY,
  };
}

function emit(candidate: Candidate): void {
  if (!getErrorTrackingConfig().enabled || isErrorCaptured(candidate.error)) return;
  const { client, initConfig } = getSdkRuntime();
  if (client === null || initConfig === null) return;
  markErrorCaptured(candidate.error);
  client.enqueue(
    buildErrorEvent({
      service: initConfig.service,
      environment: initConfig.environment,
      error: candidate.error,
      ...(candidate.context !== undefined ? { context: candidate.context } : {}),
    }),
  );
}

function markClosed(key: string): void {
  closed.delete(key);
  closed.set(key, true);
  if (closed.size > MAX_CLOSED_ROOTS) {
    const oldest = closed.keys().next().value;
    if (oldest !== undefined) closed.delete(oldest);
  }
}

/** Raiz que nunca fechou (processo que perdeu o `finish`) nao pode segurar memoria nem o erro dela. */
function flushStale(now: number): void {
  for (const [key, root] of pending) {
    if (pending.size < MAX_PENDING_ROOTS && now - root.createdAt < PENDING_TTL_MS) break;
    pending.delete(key);
    markClosed(key);
    if (root.best !== undefined) emit(root.best);
  }
}

function pendingRoot(key: string): RootErrors {
  let root = pending.get(key);
  if (root === undefined) {
    const now = Date.now();
    flushStale(now);
    root = { createdAt: now };
    pending.set(key, root);
  }
  return root;
}

/**
 * Excecao registrada num span. `depth` 0 = raiz local. Chamado com o span ainda no contexto, entao o evento
 * leva a requisicao, o usuario, as tags e o negocio dele.
 */
export function recordSpanError(params: {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  depth: number;
  error: Error;
}): void {
  safeRun('errorTracking.record', () => {
    if (!getErrorTrackingConfig().enabled || isErrorCaptured(params.error)) return;
    const candidate: Candidate = {
      ...params,
      context: contextFor(params.traceId, params.spanId, params.parentSpanId),
    };
    const root = currentRoot();
    const key =
      root !== undefined && root.traceId === params.traceId ? rootKey(root.traceId, root.rootSpanId) : undefined;
    if (key === undefined || closed.has(key)) {
      emit(candidate);
      return;
    }
    const entry = pendingRoot(key);
    if (entry.best === undefined || candidate.depth < entry.best.depth) entry.best = candidate;
  });
}

/**
 * A excecao vista na borda HTTP, antes de o status existir. Guardada mesmo com o Error Tracking desligado:
 * o span raiz ainda precisa dela para `error_type`/`error_message` em 5xx. Fica a primeira: e a que escapou.
 */
export function recordBoundaryError(error: unknown, root?: { traceId: string; rootSpanId: string }): void {
  safeRun('errorTracking.boundary', () => {
    const target = root ?? currentRoot();
    if (target === undefined || !(error instanceof Error)) return;
    const entry = pendingRoot(rootKey(target.traceId, target.rootSpanId));
    if (entry.boundary === undefined) entry.boundary = { error, context: mergeEventContext() };
  });
}

/**
 * Fecha a raiz local e emite o candidato vencedor. `statusCode` so existe na borda HTTP: com status de erro
 * de servidor, a excecao de borda vence tudo — ela e do proprio span raiz, `depth` 0. Devolve essa excecao
 * para o span raiz levar `error_type`/`error_message`, como o `addStatusError` do Datadog. Um abort depois
 * de um 5xx ja decidido continua sendo 5xx (mesma regra de `httpRootSpanOutcome`).
 */
export function completeLocalRoot(params: {
  traceId: string;
  rootSpanId: string;
  remoteParentSpanId?: string | undefined;
  statusCode?: number | undefined;
}): { boundaryError?: Error } {
  return (
    safeRun('errorTracking.complete', () => {
      const key = rootKey(params.traceId, params.rootSpanId);
      const entry = pending.get(key);
      pending.delete(key);
      markClosed(key);
      if (entry === undefined) return {};
      const serverError =
        params.statusCode !== undefined && getErrorTrackingConfig().isServerErrorStatus(params.statusCode);
      let winner = entry.best;
      if (serverError && entry.boundary !== undefined) {
        const base = entry.boundary.context ?? {};
        const http = base.http;
        winner = {
          error: entry.boundary.error,
          traceId: params.traceId,
          spanId: params.rootSpanId,
          parentSpanId: params.remoteParentSpanId ?? null,
          depth: 0,
          context: {
            ...base,
            ...(typeof http === 'object' && http !== null
              ? { http: { ...(http as Record<string, unknown>), response_status_code: params.statusCode } }
              : {}),
            trace: traceBlock(params.traceId, params.rootSpanId, params.remoteParentSpanId),
            captured_by: ERROR_TRACKING_CAPTURED_BY,
          },
        };
      }
      if (winner !== undefined) emit(winner);
      return serverError && entry.boundary !== undefined ? { boundaryError: entry.boundary.error } : {};
    }) ?? {}
  );
}
