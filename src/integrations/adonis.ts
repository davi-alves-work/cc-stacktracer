import { randomBytes } from 'node:crypto';
import type { StackTracePlugin } from '../core/plugins/types.js';
import { runWithRequestContextAsync, type HttpRequestSnapshot } from '../core/request-context.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { getStackTraceClient } from '../index.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { normalizeHttpRouteForSpan } from '../shared/schema/index.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';
import { completeLocalRoot, recordBoundaryError } from '../core/error-tracking.js';
import { warnRemovedCaptureErrors } from './removed-options.js';

export type StacktraceAdonisOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
  /**
   * When false, no root HTTP span row is emitted (the integration captures nothing for the request).
   * Default true.
   */
  emitHttpRootSpan?: boolean;
};

/**
 * Minimal shape compatible with AdonisJS v6 HttpContext for request/response capture.
 */
export type AdonisHttpContextLike = {
  request: {
    method(): string;
    url(): string;
    headers(): Record<string, string>;
    ip?(): string;
    header?(name: string): string | undefined;
    protocol?(): string;
  };
  response: {
    getResponse(): { statusCode: number; on?(event: string, cb: () => void): void };
  };
  route?: { pattern?: string };
};

function getClient(opts: StacktraceAdonisOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

type RequestTelemetry = {
  snapshot: HttpRequestSnapshot;
  traceId: string;
  rootSpanId: string;
  parentSpanId: string | undefined;
  traceFlags: string | undefined;
  raw: ReturnType<AdonisHttpContextLike['response']['getResponse']>;
  emit: (aborted: boolean) => void;
};

function prepareRequest(ctx: AdonisHttpContextLike, opts: StacktraceAdonisOptions | undefined): RequestTelemetry {
  const start = Date.now();
  const method = ctx.request.method();
  const url = ctx.request.url();
  const rawHeaders = ctx.request.headers();
  const client = getClient(opts);
  const correlation = extractCorrelationFromHeaders(rawHeaders);
  const headers = redactHeaders(rawHeaders, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
  const snapshot: HttpRequestSnapshot = { method, url: redactUrl(url, client?.getUrlRedactionOptions()), headers };
  const raw = ctx.response.getResponse();
  const emitHttpRootSpan = opts?.emitHttpRootSpan !== false;
  const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
  const rootSpanId = randomBytes(8).toString('hex');

  // Emit the root span exactly once, however the request ends. `finish` covers a completed
  // response; `close` is the fallback for aborted/timed-out connections where `finish` never
  // fires — without it the server span (which carries the route) is lost and the child spans
  // are left orphaned.
  let emitted = false;
  const emit = (aborted: boolean): void => {
    if (emitted) return;
    emitted = true;
    const statusCode = raw.statusCode ?? 200;
    // O exception handler do Adonis ja decidiu o status. Fecha a raiz do Error Tracking antes de qualquer
    // corte (cliente ausente, politica de captura, emitHttpRootSpan: false) — o evento tem politica propria.
    const { boundaryError } = completeLocalRoot({
      traceId,
      rootSpanId,
      remoteParentSpanId: correlation.parentSpanId,
      statusCode,
    });
    if (!client) return;
    const durationMs = Date.now() - start;
    snapshot.statusCode = statusCode;
    const pathOnly = url.split('?')[0] ?? url;
    const routePattern = ctx.route?.pattern;
    const endpoint = typeof routePattern === 'string' && routePattern.trim() !== '' ? routePattern : pathOnly;

    if (!client.shouldCaptureHttpRequest({ endpoint, status_code: statusCode })) {
      return;
    }
    if (!emitHttpRootSpan) {
      return;
    }

    /** Use closure ids: `on("finish")` may run outside ALS, so avoid getTraceIdFromContext() here. */
    const startIso = new Date(start).toISOString();
    const endIso = new Date().toISOString();
    const routeLabel = typeof routePattern === 'string' && routePattern !== '' ? routePattern : pathOnly;
    const httpRoute = normalizeHttpRouteForSpan(method, routeLabel) ?? routeLabel;
    client.enqueueSpan({
      span_timestamp: endIso,
      trace_id: traceId,
      span_id: rootSpanId,
      parent_span_id: correlation.parentSpanId ?? null,
      service_name: client.getServiceDescriptor().name,
      service_version: client.getServiceDescriptor().version,
      environment: client.getEnvironment(),
      span_name: `${method} ${routeLabel}`.slice(0, 1024),
      span_type: 'http',
      start_time: startIso,
      end_time: endIso,
      duration_us: Math.max(0, Math.round(durationMs * 1000)),
      ...httpRootSpanOutcome(aborted, statusCode, boundaryError),
      http_method: method,
      http_route: httpRoute.slice(0, 4096),
    });
  };

  return {
    snapshot,
    traceId,
    rootSpanId,
    parentSpanId: correlation.parentSpanId,
    traceFlags: correlation.traceFlags,
    raw,
    emit,
  };
}

/**
 * AdonisJS v6-style HTTP middleware: (ctx, next). Establishes the same request + trace AsyncLocalStorage
 * scope as the Fastify plugin so {@link withSpan} / span rows correlate, and emits a root HTTP span when
 * {@link StacktraceAdonisOptions.emitHttpRootSpan} is true.
 *
 * `next()` roda exatamente uma vez e o erro dele sobe intacto; a telemetria em volta nunca lança.
 */
export function stacktraceAdonisMiddleware(
  opts?: StacktraceAdonisOptions,
): (ctx: AdonisHttpContextLike, next: () => Promise<void>) => Promise<void> {
  warnRemovedCaptureErrors(opts, 'stacktraceAdonisMiddleware');
  return async (ctx: AdonisHttpContextLike, next: () => Promise<void>) => {
    const telemetry = isTelemetryActive() ? safeRun('adonis.setup', () => prepareRequest(ctx, opts)) : undefined;
    if (telemetry === undefined) {
      return next();
    }
    await runWithRequestContextAsync(telemetry.snapshot, async () =>
      runWithTraceContext(
        telemetry.traceId,
        telemetry.rootSpanId,
        async () => {
          const { raw } = telemetry;
          const listening =
            safeRun('adonis.listeners', () => {
              if (typeof raw.on !== 'function') return false;
              raw.on('finish', () => safeRun('adonis.finish', () => telemetry.emit(false)));
              raw.on('close', () => safeRun('adonis.close', () => telemetry.emit(true)));
              return true;
            }) === true;
          try {
            await next();
          } catch (err) {
            safeRun('adonis.recordError', () => recordBoundaryError(err));
            throw err;
          }
          if (!listening) {
            safeRun('adonis.emit', () => telemetry.emit(false));
          }
        },
        telemetry.parentSpanId,
        telemetry.traceFlags,
      ),
    );
  };
}

/** Registry entry; use `stacktraceAdonisMiddleware()` in the HTTP kernel. */
export const stackTracePlugin: StackTracePlugin = {
  name: 'http-adonis',
  type: 'http',
  init() {
    /* No-op: apply middleware in your Adonis app. */
  },
};
