/**
 * Parses W3C `traceparent` (`version-trace_id-parent_id-trace_flags`).
 * The third segment is the W3C **parent-id** (parent span id in the distributed trace).
 * @see https://www.w3.org/TR/trace-context/
 */
export type ParsedTraceparent = {
  traceId: string;
  /** W3C `parent-id` field (16 hex). */
  parentSpanId: string;
  traceFlags: string;
  /**
   * Same as `parentSpanId` — kept for callers that historically treated the header’s parent-id as “span id”.
   * @deprecated Prefer `parentSpanId`.
   */
  spanId: string;
};

/**
 * Builds a W3C `traceparent` for an outbound call: `00-{trace_id}-{span_id}-{trace_flags}`.
 * `spanId` is the **outbound client span id**, which the downstream service adopts as its `parent_span_id`.
 */
export function buildTraceparent(traceId: string, spanId: string, traceFlags = '01'): string {
  const flags = /^[0-9a-f]{2}$/i.test(traceFlags) ? traceFlags.toLowerCase() : '01';
  return `00-${traceId}-${spanId}-${flags}`;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | undefined {
  if (value === undefined || value === '') return undefined;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return undefined;
  const [, traceId, parentId, flags] = parts;
  if (traceId === undefined || parentId === undefined || flags === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/i.test(traceId) || !/^[0-9a-f]{16}$/i.test(parentId)) return undefined;
  if (!/^[0-9a-f]{2}$/i.test(flags)) return undefined;
  const tid = traceId.toLowerCase();
  const pid = parentId.toLowerCase();
  const fl = flags.toLowerCase();
  return {
    traceId: tid,
    parentSpanId: pid,
    traceFlags: fl,
    spanId: pid,
  };
}
