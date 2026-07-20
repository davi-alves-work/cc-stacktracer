/**
 * Current instant as an ISO-8601 UTC string (same shape as `Date.prototype.toISOString()`).
 */
export function nowIso(): string {
  return new Date().toISOString();
}
