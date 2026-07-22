import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { StackTracePlugin } from '../core/plugins/types.js';
import { getRequestSnapshot, runWithRequestContext } from '../core/request-context.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import type { StackTraceClient } from '../core/stacktrace-client.js';
import { getStackTraceClient } from '../index.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { headersToRecord } from '../utils/headers.js';
import { redactUrl } from '../utils/redact-url.js';
import { normalizeHttpRouteForSpan } from '../shared/schema/index.js';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';

export type StacktracePluginOptions = {
  /** Override for tests; defaults to singleton from init(). */
  client?: StackTraceClient | null;
};

function getOptionsClient(opts: StacktracePluginOptions | undefined): StackTraceClient | null {
  if (opts?.client !== undefined) return opts.client;
  return getStackTraceClient();
}

const START_TIME_KEY = Symbol.for('cc-stacktracer.startTime');
const TRACE_CTX_KEY = Symbol.for('cc-stacktracer.traceCtx');
const EMITTED_KEY = Symbol.for('cc-stacktracer.rootSpanEmitted');

type RootTraceCtx = { traceId: string; rootSpanId: string; parentSpanId: string | undefined };

type TracedRequest = FastifyRequest & {
  [START_TIME_KEY]?: number;
  [TRACE_CTX_KEY]?: RootTraceCtx;
  [EMITTED_KEY]?: boolean;
  routerPath?: string;
};

/**
 * Emits the root HTTP span exactly once, however the request ends. The trace context is read from
 * the request (not AsyncLocalStorage) so it is available from terminal handlers that run outside the
 * request's async scope — notably the raw `close` event used as the abort/timeout fallback.
 */
function emitRootSpan(
  request: FastifyRequest,
  reply: FastifyReply,
  client: StackTraceClient | null,
  aborted: boolean,
): void {
  if (client === null) return;

  const req = request as TracedRequest;
  if (req[EMITTED_KEY] === true) return;

  const ctx = req[TRACE_CTX_KEY];
  if (ctx === undefined) return;

  const snap = getRequestSnapshot();
  if (snap !== undefined) {
    snap.statusCode = reply.statusCode;
  }

  const route =
    typeof req.routerPath === 'string' && req.routerPath !== '' ? req.routerPath : request.routeOptions?.url;

  if (
    !client.shouldCaptureHttpRequest({
      endpoint: typeof route === 'string' ? route : request.url,
      status_code: reply.statusCode,
    })
  ) {
    // Capture policy says skip — record the decision so the fallback does not retry.
    req[EMITTED_KEY] = true;
    return;
  }

  req[EMITTED_KEY] = true;

  const startMs = req[START_TIME_KEY];
  const endMs = Date.now();
  const durationMs = startMs !== undefined ? endMs - startMs : 0;
  const pathOnly = request.url.split('?')[0] ?? request.url;
  const startIso = startMs !== undefined ? new Date(startMs).toISOString() : new Date(endMs - durationMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const routeLabel = typeof route === 'string' && route !== '' ? route : pathOnly;
  const httpRoute = normalizeHttpRouteForSpan(request.method, routeLabel) ?? routeLabel;

  client.enqueueSpan({
    span_timestamp: endIso,
    trace_id: ctx.traceId,
    span_id: ctx.rootSpanId,
    parent_span_id: ctx.parentSpanId ?? null,
    service_name: client.getServiceDescriptor().name,
    service_version: client.getServiceDescriptor().version,
    environment: client.getEnvironment(),
    span_name: `${request.method} ${routeLabel}`.slice(0, 1024),
    span_type: 'http',
    start_time: startIso,
    end_time: endIso,
    duration_us: Math.max(0, Math.round(durationMs * 1000)),
    ...httpRootSpanOutcome(aborted, reply.statusCode),
    http_method: request.method,
    http_route: httpRoute.slice(0, 4096),
  });
}

async function stacktracePluginImpl(
  fastify: FastifyInstance,
  opts: StacktracePluginOptions | undefined,
): Promise<void> {
  const getClient = (): StackTraceClient | null => getOptionsClient(opts);

  fastify.addHook('onRequest', (request, reply, next) => {
    const client = getClient();
    const raw = headersToRecord(request.headers);
    const headers = redactHeaders(raw, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() });
    const snapshot = {
      method: request.method,
      url: redactUrl(request.url, client?.getUrlRedactionOptions()),
      headers,
    };
    const req = request as TracedRequest;
    req[START_TIME_KEY] = Date.now();
    const correlation = extractCorrelationFromHeaders(raw);
    const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    req[TRACE_CTX_KEY] = { traceId, rootSpanId, parentSpanId: correlation.parentSpanId };

    // Fallback for aborted/timed-out connections: the response `close` fires even when the
    // request never completes normally (so `onSend` never runs). `writableFinished` is false
    // when the socket closed before the response was flushed. Without this the server span —
    // and the route it carries — is lost and the child spans are orphaned.
    reply.raw.once('close', () => {
      emitRootSpan(request, reply, getClient(), reply.raw.writableFinished !== true);
    });

    runWithRequestContext(snapshot, () => {
      runWithTraceContext(traceId, rootSpanId, next, correlation.parentSpanId, correlation.traceFlags);
    });
  });

  fastify.addHook('onError', (_request, reply, _error, done) => {
    const snap = getRequestSnapshot();
    if (snap !== undefined) {
      snap.statusCode = reply.statusCode;
    }
    done();
  });

  fastify.addHook('onSend', (request, reply, _payload, next) => {
    emitRootSpan(request, reply, getClient(), false);
    next();
  });
}

const stacktracePlugin = fp(stacktracePluginImpl, { name: 'cc-stacktracer' });
export default stacktracePlugin;

/** Registry entry; attach hooks via `app.register(default)` or `StackTrace.auto({ fastify: app })`. */
export const stackTracePlugin: StackTracePlugin = {
  name: 'http-fastify',
  type: 'http',
  init() {
    /* No-op: use the Fastify default export. */
  },
};
