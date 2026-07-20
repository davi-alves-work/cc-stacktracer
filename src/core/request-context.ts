import { AsyncLocalStorage } from 'node:async_hooks';
import { getBusinessContext } from './business-context.js';
import { getScopeContextForMerge } from './scope-metadata.js';
import { extractCorrelationFromHeaders, hasCorrelationData } from '../utils/correlation.js';
import { getTraceSpanState } from './trace-span-context.js';

/** Minimal HTTP snapshot attached to events when inside request scope. */
export type HttpRequestSnapshot = {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Set by the Fastify plugin when the response status is known (may be undefined if an error is captured before send). */
  statusCode?: number;
};

const storage = new AsyncLocalStorage<HttpRequestSnapshot>();

export function runWithRequestContext<T>(snapshot: HttpRequestSnapshot, fn: () => T): T {
  return storage.run(snapshot, fn);
}

export function runWithRequestContextAsync<T>(snapshot: HttpRequestSnapshot, fn: () => Promise<T>): Promise<T> {
  return storage.run(snapshot, fn);
}

export function getRequestSnapshot(): HttpRequestSnapshot | undefined {
  return storage.getStore();
}

/**
 * Merges AsyncLocalStorage business context, module scope (user/tags), HTTP ALS snapshot, then caller `context`.
 * Caller keys win last (explicit overrides ALS defaults).
 * Adds `headers` (for normalization trace resolution) and `trace` when `traceparent` is present,
 * so `normalizeEventV4` can populate `trace.trace_id` without reading nested `http.headers`.
 */
export function mergeEventContext(explicit?: Record<string, unknown>): Record<string, unknown> | undefined {
  const layers: Record<string, unknown>[] = [];
  const business = getBusinessContext();
  if (business !== undefined) {
    layers.push({ business });
  }
  const scope = getScopeContextForMerge();
  if (scope !== undefined) {
    layers.push(scope);
  }
  const snap = getRequestSnapshot();
  if (snap !== undefined) {
    const corrFromHeaders = extractCorrelationFromHeaders(snap.headers);
    const httpLayer: Record<string, unknown> = {
      method: snap.method,
      url: snap.url,
      headers: snap.headers,
      ...(snap.statusCode !== undefined ? { response_status_code: snap.statusCode } : {}),
    };
    const reqLayer: Record<string, unknown> = { http: httpLayer, headers: snap.headers };
    if (hasCorrelationData(corrFromHeaders)) {
      reqLayer.correlation = {
        ...(corrFromHeaders.requestId !== undefined ? { requestId: corrFromHeaders.requestId } : {}),
        ...(corrFromHeaders.traceId !== undefined ? { traceId: corrFromHeaders.traceId } : {}),
        ...(corrFromHeaders.parentSpanId !== undefined ? { parentSpanId: corrFromHeaders.parentSpanId } : {}),
      };
    }

    // The tracing ALS (trace-span-context) is the authoritative source for trace correlation
    // when we are inside a Fastify request scope. It gives us the current active span_id so
    // that log/error events are linked to the exact span they occurred in.
    const spanState = getTraceSpanState();
    if (spanState !== undefined) {
      const stack = spanState.spanStack;
      const traceBlock: Record<string, unknown> = { trace_id: spanState.traceId };
      if (stack.length > 0) {
        // The top of the stack is the currently executing span — this event belongs to it.
        traceBlock.span_id = stack[stack.length - 1];
      }
      if (stack.length > 1) {
        // Second-from-top is the parent of the current span.
        traceBlock.parent_span_id = stack[stack.length - 2];
      }
      reqLayer.trace = traceBlock;
    } else {
      // Fall back to W3C traceparent / x-request-id from inbound headers when no local span
      // context is active (e.g. events emitted outside of withSpan but still inside a request).
      const corr = extractCorrelationFromHeaders(snap.headers);
      if (corr.traceId !== undefined) {
        reqLayer.trace = {
          trace_id: corr.traceId,
          ...(corr.parentSpanId !== undefined ? { parent_span_id: corr.parentSpanId } : {}),
        };
      }
    }

    layers.push(reqLayer);
  }
  if (explicit !== undefined) {
    layers.push(explicit);
  }
  if (layers.length === 0) {
    return undefined;
  }
  return Object.assign({}, ...layers);
}

/**
 * @deprecated Use {@link mergeEventContext} — behavior is identical (full merge including business ALS).
 */
export function mergeRequestIntoContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  return mergeEventContext(context);
}
