import { createRequire } from 'node:module';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { beginOutboundSpan, endOutboundSpan, type OutboundSpanStart } from '../../core/tracing.js';
import { buildTraceparent } from '../../utils/traceparent.js';
import { classifyOutboundUrl, sanitizedTarget } from './url-classification.js';
import type { OutboundHttpOptions } from './types.js';

/** Marks a patched core module so repeated `instrumentNodeHttp()` calls don't stack wrappers. */
const INSTRUMENTED = Symbol.for('cc-stacktracer.outbound.nodeHttp.instrumented');

type AnyRequest = (...args: unknown[]) => ClientRequest;
type HttpModuleLike = {
  request: AnyRequest;
  get: AnyRequest;
  [INSTRUMENTED]?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves the request URL from the `http.request` arg forms: (options), (url), (url, options). */
function resolveUrl(args: unknown[], isHttps: boolean): URL | undefined {
  const first = args[0];
  try {
    if (typeof first === 'string') return new URL(first);
    if (first instanceof URL) return first;
    if (isPlainObject(first)) {
      const o = first;
      const protocol = typeof o.protocol === 'string' && o.protocol !== '' ? o.protocol : isHttps ? 'https:' : 'http:';
      const host = typeof o.hostname === 'string' ? o.hostname : typeof o.host === 'string' ? o.host : 'localhost';
      const port = o.port !== undefined && o.port !== null && `${o.port}` !== '' ? `:${o.port}` : '';
      const path = typeof o.path === 'string' && o.path !== '' ? o.path : '/';
      return new URL(`${protocol}//${host}${port}${path}`);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveMethod(args: unknown[]): string {
  const optionsArg = isPlainObject(args[0]) ? args[0] : isPlainObject(args[1]) ? args[1] : undefined;
  const method = optionsArg?.method;
  return typeof method === 'string' && method !== '' ? method.toUpperCase() : 'GET';
}

function withTraceparentHeader(headers: unknown, traceparent: string): Record<string, unknown> {
  const base = isPlainObject(headers) ? headers : {};
  return { ...base, traceparent };
}

/** Returns a copy of `args` with `traceparent` merged into the request options' headers. */
function injectTraceparent(args: unknown[], traceparent: string): unknown[] {
  const [first, second, third] = args;
  if (isPlainObject(first)) {
    return [{ ...first, headers: withTraceparentHeader(first.headers, traceparent) }, ...args.slice(1)];
  }
  // first is a url (string | URL)
  if (isPlainObject(second)) {
    return [first, { ...second, headers: withTraceparentHeader(second.headers, traceparent) }, ...args.slice(2)];
  }
  // (url) or (url, callback) — insert an options object carrying the header before any callback
  const headerOpts = { headers: { traceparent } };
  return second === undefined
    ? [first, headerOpts]
    : [first, headerOpts, ...(third === undefined ? [second] : [second, third])];
}

function attributesFor(
  url: URL,
  method: string,
  begin: OutboundSpanStart,
  classification: ReturnType<typeof classifyOutboundUrl>,
  status?: number,
): Record<string, unknown> {
  return {
    http_method: method,
    http_route: sanitizedTarget(url),
    'url.scheme': url.protocol.replace(':', ''),
    'server.address': url.hostname,
    ...(url.port !== '' ? { 'server.port': Number(url.port) } : {}),
    'peer.kind': classification.kind === 'internal_service' ? 'internal_service' : 'external_api',
    ...(classification.kind === 'internal_service' ? { 'peer.service': classification.serviceName } : {}),
    trace_flags: begin.traceFlags,
    ...(status !== undefined ? { http_status_code: status } : {}),
  };
}

function makeWrappedRequest(original: AnyRequest, isHttps: boolean, options: OutboundHttpOptions): AnyRequest {
  const propagate = options.propagateTraceparent !== false;
  return function instrumentedRequest(this: unknown, ...args: unknown[]): ClientRequest {
    const url = resolveUrl(args, isHttps);
    const begin = url !== undefined ? beginOutboundSpan() : null;
    if (url === undefined || begin === null) {
      return original.apply(this, args);
    }
    const classification = classifyOutboundUrl(url, options);
    if (classification.kind === 'ignored') {
      return original.apply(this, args);
    }

    const method = resolveMethod(args);
    const traceparent = buildTraceparent(begin.traceId, begin.spanId, begin.traceFlags);
    const nextArgs = propagate ? injectTraceparent(args, traceparent) : args;
    const req = original.apply(this, nextArgs);

    const name = `http.client ${method} ${url.host}`;
    let finished = false;
    const finish = (status?: number, err?: Error): void => {
      if (finished) return;
      finished = true;
      const errored =
        err ??
        (status !== undefined && status >= 500
          ? Object.assign(new Error(`HTTP ${status}`), { name: 'HttpError' })
          : undefined);
      endOutboundSpan(begin, {
        name,
        type: 'external',
        attributes: attributesFor(url, method, begin, classification, status),
        ...(errored !== undefined ? { err: errored } : {}),
      });
    };

    req.on('response', (res: IncomingMessage) => finish(res.statusCode));
    req.on('error', (err: Error) => finish(undefined, err instanceof Error ? err : new Error(String(err))));
    req.on('timeout', () => finish(undefined, Object.assign(new Error('Request timeout'), { name: 'TimeoutError' })));
    // Aborted / socket closed before a response: still close the span (no status).
    req.on('close', () => finish());
    return req;
  };
}

/**
 * Instruments `node:http` and `node:https` `request`/`get`: creates an `external` client span per outbound
 * call, injects `traceparent` (so the downstream service adopts it as `parent_span_id`), and records
 * method/status/timing. Covers libraries that bottom out at Node's http layer (axios on Node, got, etc.).
 *
 * Patches the CommonJS module objects via `createRequire`, so consumers using `require('http').request` /
 * `http.get` (incl. `follow-redirects`, used by axios) see the wrappers. Returns an uninstrument function.
 */
export function instrumentNodeHttp(options: OutboundHttpOptions = {}): () => void {
  const require = createRequire(import.meta.url);
  const restores: Array<() => void> = [];

  for (const moduleName of ['http', 'https'] as const) {
    const mod = require(`node:${moduleName}`) as HttpModuleLike;
    if (mod[INSTRUMENTED] === true) {
      continue;
    }
    const isHttps = moduleName === 'https';
    const originalRequest = mod.request;
    const originalGet = mod.get;
    const wrappedRequest = makeWrappedRequest(originalRequest, isHttps, options);

    mod.request = wrappedRequest;
    // `get` is `request` + `req.end()`; route it through the wrapped request so it shares one span.
    mod.get = function instrumentedGet(this: unknown, ...args: unknown[]): ClientRequest {
      const req = wrappedRequest.apply(this, args);
      req.end();
      return req;
    };
    mod[INSTRUMENTED] = true;

    restores.push(() => {
      mod.request = originalRequest;
      mod.get = originalGet;
      delete mod[INSTRUMENTED];
    });
  }

  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}
