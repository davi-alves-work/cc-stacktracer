import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getStackTraceClient } from '../index.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { runWithRequestContext, type HttpRequestSnapshot } from '../core/request-context.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { headersToRecord } from '../utils/headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { normalizeHttpRouteForSpan } from '../shared/schema/index.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';

export type StacktraceExpressOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
};

function getClient(opts: StacktraceExpressOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

function expressMatchedRoute(req: Request): string | undefined {
  const r = req.route as { path?: string } | undefined;
  if (r?.path === undefined) return undefined;
  const base = req.baseUrl ?? '';
  return `${base}${r.path}`;
}

/**
 * Express middleware that records each request as a request event (method, url, redacted headers, statusCode, durationMs).
 */
export function stacktraceExpressMiddleware(
  opts?: StacktraceExpressOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const startIso = new Date(start).toISOString();
    const raw = headersToRecord(req.headers as Record<string, string | string[] | undefined>);
    const client = getClient(opts);
    const headers = redactHeaders(raw, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
    const correlation = extractCorrelationFromHeaders(raw);
    const rawUrl = req.url ?? req.originalUrl ?? '';
    const snapshot: HttpRequestSnapshot = {
      method: req.method,
      url: redactUrl(rawUrl, client?.getUrlRedactionOptions()),
      headers,
    };
    const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    const pathOnly = (req.originalUrl ?? req.url).split('?')[0] ?? req.url;

    // Emit the root span exactly once, however the request ends. `finish` covers a
    // completed response; `close` is the fallback for aborted/timed-out connections
    // where the response never finishes — without it the server span (which carries
    // the route) is lost and the child spans are left orphaned.
    let emitted = false;
    const emitRootSpan = (aborted: boolean): void => {
      if (emitted) return;
      emitted = true;
      snapshot.statusCode = res.statusCode;
      if (!client) return;
      const endMs = Date.now();
      const durationMs = endMs - start;
      const endIso = new Date(endMs).toISOString();
      const route = expressMatchedRoute(req);
      const routeForSpan = typeof route === 'string' && route !== '' ? route : pathOnly;
      const httpRoute = normalizeHttpRouteForSpan(req.method, routeForSpan) ?? routeForSpan;
      client.enqueueSpan({
        span_timestamp: endIso,
        trace_id: traceId,
        span_id: rootSpanId,
        parent_span_id: correlation.parentSpanId ?? null,
        service_name: client.getServiceDescriptor().name,
        service_version: client.getServiceDescriptor().version,
        environment: client.getEnvironment(),
        span_name: `${req.method} ${routeForSpan}`.slice(0, 1024),
        span_type: 'http',
        start_time: startIso,
        end_time: endIso,
        duration_us: Math.max(0, Math.round(durationMs * 1000)),
        ...httpRootSpanOutcome(aborted, res.statusCode),
        http_method: req.method,
        http_route: httpRoute.slice(0, 4096),
      });
    };

    runWithRequestContext(snapshot, () => {
      runWithTraceContext(
        traceId,
        rootSpanId,
        () => {
          res.once('finish', () => emitRootSpan(false));
          // `writableFinished` is true once the response was fully flushed (normal path,
          // already emitted via `finish`); false means the connection closed early.
          res.once('close', () => emitRootSpan(!res.writableFinished));
          next();
        },
        correlation.parentSpanId,
        correlation.traceFlags,
      );
    });
  };
}
