import { randomBytes } from 'node:crypto';
import { getSdkRuntime } from './client-ref.js';
import { isTelemetryActive, safeRun } from './safe-run.js';
import type { SdkSpanRow } from './span-payload.types.js';
import {
  currentParentSpanIdForChild,
  currentTraceContext,
  getTraceIdFromContext,
  getTraceSpanState,
  popActiveSpan,
  pushActiveSpan,
  runWithTraceContext,
} from './trace-span-context.js';
import { getBusinessContext } from './business-context.js';
import { completeLocalRoot, recordSpanError } from './error-tracking.js';

export type SpanOptions = {
  type?: 'http' | 'db' | 'business' | 'service' | 'external';
  attributes?: Record<string, unknown>;
};

export type SpanHandle = { end: (err?: Error) => void };

/** W3C span id: 8 random bytes as 16 lowercase hex chars. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

function strAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

function numAttr(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

/** Attribute keys promoted to dedicated span columns — excluded from the free-form `attributes`. */
const PROMOTED_SPAN_ATTR_KEYS = new Set<string>([
  'http_method',
  'http_route',
  'http_status_code',
  'db_system',
  'db_operation',
  'db_table',
  'db_duration_ms',
  'db_duration_us',
  'trace_flags',
]);

function spanAttributes(attrs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (attrs === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!PROMOTED_SPAN_ATTR_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merges the active `withBusinessContext` scope (entity/operation/fields_changed) into span
 * attributes. Explicit `attributes` win on key collision — same "caller wins" rule as
 * `mergeEventContext` uses for event context (`src/core/request-context.ts`).
 */
function mergeBusinessAttributes(explicit: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const business = getBusinessContext();
  if (business === undefined) {
    return explicit;
  }
  const businessAttrs: Record<string, unknown> = {
    entity: business.entity,
    operation: business.operation,
    ...(business.fields_changed !== undefined ? { fields_changed: business.fields_changed } : {}),
  };
  return explicit === undefined ? businessAttrs : { ...businessAttrs, ...explicit };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Distancia ate a raiz local: 0 na raiz, 1 no filho direto. O span de saida nao entra na pilha (e folha),
 * entao fica logo abaixo do span em execucao.
 */
function spanDepth(spanId: string): number {
  const stack = getTraceSpanState()?.spanStack ?? [];
  const index = stack.indexOf(spanId);
  return index === -1 ? stack.length : index;
}

function buildRow(params: {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  startIso: string;
  endIso: string;
  durationUs: number;
  /** Explicit trace id (outbound spans capture it at start); falls back to the active ALS trace. */
  traceId?: string;
  options?: SpanOptions;
  err?: Error;
  /**
   * `false` para erro que so existe por status (o `HttpError` sintetico da chamada de saida): o span fica
   * com erro, mas nao ha excecao de verdade para o Error Tracking — sem stack nao ha issue, como no Datadog.
   */
  trackError?: boolean;
}): SdkSpanRow | null {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) {
    return null;
  }
  const traceId = params.traceId ?? getTraceIdFromContext();
  if (traceId === undefined) {
    return null;
  }

  const attrs = mergeBusinessAttributes(params.options?.attributes);
  const spanType = params.options?.type ?? 'business';
  const roundedDurationUs = Math.max(0, Math.round(params.durationUs));
  const dbDurMsAttr = numAttr(attrs, 'db_duration_ms');
  const dbDurAttr =
    numAttr(attrs, 'db_duration_us') ?? (dbDurMsAttr !== undefined ? Math.round(dbDurMsAttr * 1000) : undefined);
  const db_duration_us = spanType === 'db' ? (dbDurAttr ?? roundedDurationUs) : (dbDurAttr ?? null);

  if (params.err !== undefined && params.trackError !== false) {
    recordSpanError({
      traceId,
      spanId: params.spanId,
      parentSpanId: params.parentSpanId,
      depth: spanDepth(params.spanId),
      error: params.err,
    });
  }

  return {
    span_timestamp: params.endIso,
    trace_id: traceId,
    span_id: params.spanId,
    parent_span_id: params.parentSpanId,
    service_name: initConfig.service.name,
    service_version: initConfig.service.version,
    environment: initConfig.environment,
    span_name: params.name,
    span_type: spanType,
    start_time: params.startIso,
    end_time: params.endIso,
    duration_us: roundedDurationUs,
    status: params.err !== undefined ? 'error' : 'ok',
    http_method: strAttr(attrs, 'http_method') ?? null,
    http_route: strAttr(attrs, 'http_route') ?? null,
    http_status_code: numAttr(attrs, 'http_status_code') ?? null,
    db_system: strAttr(attrs, 'db_system') ?? null,
    db_operation: strAttr(attrs, 'db_operation') ?? null,
    db_table: strAttr(attrs, 'db_table') ?? null,
    db_duration_us,
    error_type: typeof params.err?.name === 'string' ? params.err.name : null,
    error_message: typeof params.err?.message === 'string' ? params.err.message.slice(0, 16_000) : null,
    trace_flags: strAttr(attrs, 'trace_flags') ?? null,
    attributes: spanAttributes(attrs),
  };
}

type ChildSpanStart = { spanId: string; parentSpanId: string | null; startIso: string; perfStart: number };

/** `undefined` sem trace ativo. O push vem por último: se algo antes lançar, a pilha fica intacta. */
function beginChildSpan(): ChildSpanStart | undefined {
  if (getTraceIdFromContext() === undefined) {
    return undefined;
  }
  const start: ChildSpanStart = {
    spanId: newSpanId(),
    parentSpanId: currentParentSpanIdForChild() ?? null,
    startIso: new Date().toISOString(),
    perfStart: performance.now(),
  };
  pushActiveSpan(start.spanId);
  return start;
}

function finishChildSpan(start: ChildSpanStart, name: string, options: SpanOptions | undefined, err?: Error): void {
  try {
    const row = buildRow({
      name,
      spanId: start.spanId,
      parentSpanId: start.parentSpanId,
      startIso: start.startIso,
      endIso: new Date().toISOString(),
      durationUs: (performance.now() - start.perfStart) * 1000,
      ...(options !== undefined ? { options } : {}),
      ...(err !== undefined ? { err } : {}),
    });
    if (row !== null) {
      getSdkRuntime().client?.enqueueSpan(row);
    }
  } finally {
    popActiveSpan();
  }
}

/**
 * O `try` envolve SÓ `fn`. Se a telemetria rodasse dentro dele, o `catch` confundiria a falha do SDK
 * com a da app: um `fn` bem-sucedido viraria exceção, e a app faria retry de algo que já aconteceu.
 */
export async function withSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanOptions): Promise<T> {
  const started = isTelemetryActive() ? safeRun('withSpan.start', beginChildSpan) : undefined;
  if (started === undefined) {
    return fn();
  }
  let out: Awaited<T>;
  try {
    out = await fn();
  } catch (err) {
    safeRun('withSpan.end', () => finishChildSpan(started, name, options, asError(err)));
    throw err;
  }
  safeRun('withSpan.end', () => finishChildSpan(started, name, options));
  return out;
}

type RootSpanStart = { traceId: string; spanId: string; startIso: string; perfStart: number; options: SpanOptions };

function beginRootSpan(options: SpanOptions | undefined): RootSpanStart {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: newSpanId(),
    startIso: new Date().toISOString(),
    perfStart: performance.now(),
    // Spread first, then apply the default: guards against a `type: undefined` explicitly present on
    // `options` clobbering the default.
    options: { ...options, type: options?.type ?? 'service' },
  };
}

function finishRootSpan(root: RootSpanStart, name: string, err?: Error): void {
  const row = buildRow({
    name,
    spanId: root.spanId,
    parentSpanId: null,
    startIso: root.startIso,
    endIso: new Date().toISOString(),
    durationUs: (performance.now() - root.perfStart) * 1000,
    traceId: root.traceId,
    options: root.options,
    ...(err !== undefined ? { err } : {}),
  });
  if (row !== null) {
    getSdkRuntime().client?.enqueueSpan(row);
  }
}

/**
 * Abre um trace para um ponto de entrada que NÃO é HTTP — job, consumer de fila, cron, CLI — e emite o
 * span raiz ao fim.
 *
 * Sem isto, esses pontos de entrada não produziam telemetria nenhuma: `buildRow` devolve `null` quando
 * não há trace ativo, então `withSpan` dentro de um job era um no-op silencioso, e os logs do job saíam
 * sem correlação.
 *
 * Dentro de um trace já ativo, delega para {@link withSpan}: um job disparado de dentro de uma requisição
 * pertence ao trace DELA, e abrir um segundo trace partiria a história em duas.
 */
export async function withTrace<T>(name: string, fn: () => Promise<T> | T, options?: SpanOptions): Promise<T> {
  if (getTraceIdFromContext() !== undefined) {
    return withSpan(name, fn, options);
  }
  const root = isTelemetryActive() ? safeRun('withTrace.start', () => beginRootSpan(options)) : undefined;
  if (root === undefined) {
    return fn();
  }
  return runWithTraceContext(root.traceId, root.spanId, async () => {
    let out: Awaited<T>;
    try {
      out = await fn();
    } catch (err) {
      safeRun('withTrace.end', () => finishRootSpan(root, name, asError(err)));
      completeLocalRoot({ traceId: root.traceId, rootSpanId: root.spanId });
      throw err;
    }
    safeRun('withTrace.end', () => finishRootSpan(root, name));
    // Mesmo com o job bem-sucedido: um erro tratado la dentro (fallback) ainda e o erro desta raiz.
    completeLocalRoot({ traceId: root.traceId, rootSpanId: root.spanId });
    return out;
  });
}

export function startSpan(name: string, options?: SpanOptions): SpanHandle {
  const started = isTelemetryActive() ? safeRun('startSpan.start', beginChildSpan) : undefined;
  if (started === undefined) {
    return { end: () => {} };
  }
  let ended = false;
  return {
    end: (err?: Error) => {
      if (ended) {
        return;
      }
      ended = true;
      safeRun('startSpan.end', () => finishChildSpan(started, name, options, err));
    },
  };
}

export function endSpan(handle: SpanHandle, err?: Error): void {
  safeRun('endSpan', () => handle.end(err));
}

/**
 * Captured trace state for an outbound (client) span. Unlike {@link startSpan}, an outbound span is a
 * **leaf**: it is NOT pushed onto the active span stack, so concurrent in-flight calls each parent to the
 * enclosing span (the request root / current span) instead of nesting under each other.
 */
export type OutboundSpanStart = {
  traceId: string;
  /** Outbound client span id — inject this into the downstream `traceparent`. */
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
  startIso: string;
  perfStart: number;
};

/** Begins an outbound client span from the active trace, or returns `null` when no trace is active. */
export function beginOutboundSpan(): OutboundSpanStart | null {
  if (!isTelemetryActive()) {
    return null;
  }
  return (
    safeRun<OutboundSpanStart | null>('beginOutboundSpan', () => {
      const ctx = currentTraceContext();
      if (ctx === undefined) {
        return null;
      }
      return {
        traceId: ctx.traceId,
        spanId: newSpanId(),
        parentSpanId: ctx.parentSpanId ?? null,
        traceFlags: ctx.traceFlags,
        startIso: new Date().toISOString(),
        perfStart: performance.now(),
      };
    }) ?? null
  );
}

/** Finalizes and enqueues an outbound client span. Callers must guard against double-finalization. */
export function endOutboundSpan(
  begin: OutboundSpanStart,
  params: {
    name: string;
    type?: SpanOptions['type'];
    attributes?: Record<string, unknown>;
    err?: Error;
    /** O `err` so representa o status da resposta — marca o span, mas fica fora do Error Tracking. */
    errorFromStatus?: boolean;
  },
): void {
  safeRun('endOutboundSpan', () => {
    const options: SpanOptions = {
      type: params.type ?? 'external',
      ...(params.attributes !== undefined ? { attributes: params.attributes } : {}),
    };
    const row = buildRow({
      name: params.name,
      traceId: begin.traceId,
      spanId: begin.spanId,
      parentSpanId: begin.parentSpanId,
      startIso: begin.startIso,
      endIso: new Date().toISOString(),
      durationUs: (performance.now() - begin.perfStart) * 1000,
      options,
      ...(params.err !== undefined ? { err: params.err } : {}),
      trackError: params.errorFromStatus !== true,
    });
    if (row !== null) {
      getSdkRuntime().client?.enqueueSpan(row);
    }
  });
}
