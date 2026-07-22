import { randomBytes } from 'node:crypto';
import type { StackTracePlugin } from '../core/plugins/types.js';
import { runWithRequestContextAsync, type HttpRequestSnapshot } from '../core/request-context.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { getStackTraceClient } from '../index.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { normalizeHttpRouteForSpan } from '../shared/schema/index.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';

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

/**
 * AdonisJS v6-style HTTP middleware: (ctx, next). Captures method, url, redacted headers, statusCode, durationMs.
 * Establishes the same request + trace AsyncLocalStorage scope as the Fastify plugin so {@link withSpan} / span
 * rows correlate, and emits a root HTTP span when {@link StacktraceAdonisOptions.emitHttpRootSpan} is true.
 */
export function stacktraceAdonisMiddleware(
  opts?: StacktraceAdonisOptions,
): (ctx: AdonisHttpContextLike, next: () => Promise<void>) => Promise<void> {
  return async (ctx: AdonisHttpContextLike, next: () => Promise<void>) => {
    const start = Date.now();
    const method = ctx.request.method();
    const url = ctx.request.url();
    const rawHeaders = ctx.request.headers();
    const client = getClient(opts);
    const correlation = extractCorrelationFromHeaders(rawHeaders);
    const headers = redactHeaders(rawHeaders, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
    const redactedUrl = redactUrl(url, client?.getUrlRedactionOptions());
    const snapshot: HttpRequestSnapshot = { method, url: redactedUrl, headers };
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
      if (!client) return;
      const durationMs = Date.now() - start;
      const statusCode = raw.statusCode ?? 200;
      snapshot.statusCode = statusCode;
      const pathOnly = url.split('?')[0] ?? url;
      const routePattern = ctx.route?.pattern;
      const endpoint = typeof routePattern === 'string' && routePattern.trim() !== '' ? routePattern : pathOnly;

      if (
        !client.shouldCaptureHttpRequest({
          endpoint,
          status_code: statusCode,
        })
      ) {
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
        ...httpRootSpanOutcome(aborted, statusCode),
        http_method: method,
        http_route: httpRoute.slice(0, 4096),
      });
    };

    await runWithRequestContextAsync(snapshot, async () =>
      runWithTraceContext(
        traceId,
        rootSpanId,
        async () => {
          if (typeof raw.on === 'function') {
            raw.on('finish', () => emit(false));
            raw.on('close', () => emit(true));
          }
          await next();
          if (typeof raw.on !== 'function') {
            emit(false);
          }
        },
        correlation.parentSpanId,
        correlation.traceFlags,
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
