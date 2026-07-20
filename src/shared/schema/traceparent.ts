/**
 * Parses W3C `traceparent` (`version-trace_id-parent_id-trace_flags`) for trace id extraction.
 * @see https://www.w3.org/TR/trace-context/
 */
export function parseTraceparentTraceId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return undefined;
  const [, traceId] = parts;
  if (traceId === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return undefined;
  return traceId.toLowerCase();
}
