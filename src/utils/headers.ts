/**
 * Converts a raw Node/Fastify/Express header map (where values may be arrays
 * or undefined) into a flat `Record<string, string>`.
 * Array values are joined with ', ' per HTTP spec (RFC 7230 §3.2.2).
 */
export function headersToRecord(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
