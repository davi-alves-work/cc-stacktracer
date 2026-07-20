import { AsyncLocalStorage } from 'node:async_hooks';

export type TraceSpanAlsState = {
  traceId: string;
  /** Active span chain; last element is the current parent for new child spans. */
  spanStack: string[];
  /**
   * Remote parent span id adopted from an inbound W3C `traceparent` (16 hex), when present.
   * The HTTP server (root) span uses this as its `parent_span_id`; absent ⇒ the root span is a true root.
   */
  remoteParentSpanId?: string;
  /** W3C trace flags (2 hex) carried from the inbound `traceparent`; used when propagating outbound. */
  traceFlags?: string;
};

/** Snapshot of the active trace for outbound propagation (parent = current span for a new child). */
export type CurrentTraceContext = {
  traceId: string;
  parentSpanId: string | undefined;
  traceFlags: string;
};

const storage = new AsyncLocalStorage<TraceSpanAlsState>();

/**
 * Runs `fn` with trace correlation. `rootSpanId` is pushed as the initial parent (HTTP root span).
 * `remoteParentSpanId` (from an inbound `traceparent`) makes the root span a child of the upstream caller's span.
 */
export function runWithTraceContext<T>(
  traceId: string,
  rootSpanId: string,
  fn: () => T,
  remoteParentSpanId?: string,
  traceFlags?: string,
): T {
  return storage.run(
    {
      traceId,
      spanStack: [rootSpanId],
      ...(remoteParentSpanId !== undefined ? { remoteParentSpanId } : {}),
      ...(traceFlags !== undefined ? { traceFlags } : {}),
    },
    fn,
  );
}

export function getTraceSpanState(): TraceSpanAlsState | undefined {
  return storage.getStore();
}

export function getTraceIdFromContext(): string | undefined {
  return storage.getStore()?.traceId;
}

/** Parent span id for a new child, or undefined if stack empty. */
export function currentParentSpanIdForChild(): string | undefined {
  const s = storage.getStore();
  if (s === undefined || s.spanStack.length === 0) {
    return undefined;
  }
  return s.spanStack[s.spanStack.length - 1];
}

export function pushActiveSpan(spanId: string): void {
  const s = storage.getStore();
  if (s !== undefined) {
    s.spanStack.push(spanId);
  }
}

export function popActiveSpan(): void {
  const s = storage.getStore();
  if (s !== undefined && s.spanStack.length > 0) {
    s.spanStack.pop();
  }
}

/** Root span id (first on stack) when inside Fastify request trace context. */
export function rootSpanIdFromContext(): string | undefined {
  const s = storage.getStore();
  return s !== undefined && s.spanStack.length > 0 ? s.spanStack[0] : undefined;
}

/** Remote parent span id (from inbound `traceparent`) for the current request, if any. */
export function remoteParentSpanIdFromContext(): string | undefined {
  return storage.getStore()?.remoteParentSpanId;
}

/**
 * Active trace snapshot for outbound propagation: the `trace_id`, the current span (parent for the new
 * outbound client span), and trace flags (default `01`). Returns `undefined` when no trace is active.
 */
export function currentTraceContext(): CurrentTraceContext | undefined {
  const s = storage.getStore();
  if (s === undefined) {
    return undefined;
  }
  return {
    traceId: s.traceId,
    parentSpanId: s.spanStack.length > 0 ? s.spanStack[s.spanStack.length - 1] : undefined,
    traceFlags: s.traceFlags ?? '01',
  };
}
