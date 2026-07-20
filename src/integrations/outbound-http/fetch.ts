import { beginOutboundSpan, endOutboundSpan } from '../../core/tracing.js';
import { buildTraceparent } from '../../utils/traceparent.js';
import { classifyOutboundUrl, sanitizedTarget } from './url-classification.js';
import type { OutboundHttpOptions } from './types.js';

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

/** Marks the wrapped global `fetch` so repeated `instrumentFetch()` calls don't stack wrappers. */
const FETCH_INSTRUMENTED = Symbol.for('cc-stacktracer.outbound.fetch.instrumented');

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function resolveUrl(input: FetchInput): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (isRequest(input)) return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveMethod(input: FetchInput, init: FetchInit): string {
  if (init?.method !== undefined && init.method !== '') return init.method;
  if (isRequest(input)) return input.method;
  return 'GET';
}

/** Returns a new `init` with `traceparent` set, merging Request headers (when input is a Request) + init headers. */
function withTraceparent(input: FetchInput, init: FetchInit, traceparent: string): FetchInit {
  const merged = new Headers();
  if (isRequest(input)) {
    input.headers.forEach((value, key) => merged.set(key, value));
  }
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  }
  merged.set('traceparent', traceparent);
  return { ...(init ?? {}), headers: merged };
}

/**
 * Instruments the global `fetch`: creates an `external` client span per call, injects `traceparent` with the
 * client span id (so the downstream service adopts it as `parent_span_id`), and records status/timing.
 *
 * - No active trace context ⇒ pass through untouched (no span).
 * - Ignored URLs (ingestion endpoint, `ignoreUrls`, non-`allowUrls`) ⇒ pass through untouched.
 * - Headers are not captured by default (only `traceparent` is injected).
 *
 * Returns an uninstrument function. Idempotent: a second call while already instrumented is a no-op.
 */
export function instrumentFetch(options: OutboundHttpOptions = {}): () => void {
  const globalRef = globalThis as typeof globalThis & { fetch?: FetchFn };
  const current = globalRef.fetch;
  if (typeof current !== 'function') {
    return () => {};
  }
  if ((current as { [FETCH_INSTRUMENTED]?: boolean })[FETCH_INSTRUMENTED] === true) {
    return () => {};
  }
  const original = current;
  const propagate = options.propagateTraceparent !== false;

  const wrapped = async function instrumentedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const url = resolveUrl(input);
    const begin = url !== undefined ? beginOutboundSpan() : null;
    if (url === undefined || begin === null) {
      return original(input, init);
    }
    const classification = classifyOutboundUrl(url, options);
    if (classification.kind === 'ignored') {
      return original(input, init);
    }

    const method = resolveMethod(input, init).toUpperCase();
    const nextInit = propagate
      ? withTraceparent(input, init, buildTraceparent(begin.traceId, begin.spanId, begin.traceFlags))
      : init;

    const attributes: Record<string, unknown> = {
      http_method: method,
      http_route: sanitizedTarget(url),
      'url.scheme': url.protocol.replace(':', ''),
      'server.address': url.hostname,
      ...(url.port !== '' ? { 'server.port': Number(url.port) } : {}),
      'peer.kind': classification.kind === 'internal_service' ? 'internal_service' : 'external_api',
      ...(classification.kind === 'internal_service' ? { 'peer.service': classification.serviceName } : {}),
      trace_flags: begin.traceFlags,
    };
    const name = `http.client ${method} ${url.host}`;

    try {
      const response = await original(input, nextInit);
      const errored = response.status >= 500;
      const err = errored ? Object.assign(new Error(`HTTP ${response.status}`), { name: 'HttpError' }) : undefined;
      endOutboundSpan(begin, {
        name,
        type: 'external',
        attributes: { ...attributes, http_status_code: response.status },
        ...(err !== undefined ? { err } : {}),
      });
      return response;
    } catch (rawErr) {
      const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      endOutboundSpan(begin, { name, type: 'external', attributes, err });
      throw rawErr;
    }
  } as FetchFn;

  (wrapped as { [FETCH_INSTRUMENTED]?: boolean })[FETCH_INSTRUMENTED] = true;
  globalRef.fetch = wrapped;
  return () => {
    if (globalRef.fetch === wrapped) {
      globalRef.fetch = original;
    }
  };
}
