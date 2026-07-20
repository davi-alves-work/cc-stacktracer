/**
 * Canonical span naming convention — produces standardized span names for trace visualization,
 * grouping, and latency analysis. Pattern: `<domain>.<verb> <CONTEXT>`.
 *
 * Use these helpers instead of raw strings so span names are consistent across the codebase
 * and can be reliably parsed by analytics pipelines.
 */

/** HTTP server/client span: `http.request GET /users/:id` */
export function httpSpanName(method: string, route: string): string {
  return `http.request ${method.toUpperCase()} ${route}`;
}

/**
 * Database query span: `db.query UPDATE users` or `db.query SELECT` when table is unknown.
 * `operation` is normalized to uppercase (SELECT, INSERT, UPDATE, DELETE, …).
 */
export function dbSpanName(operation: string, table?: string): string {
  const op = operation.toUpperCase();
  return table !== undefined && table.trim() !== '' ? `db.query ${op} ${table}` : `db.query ${op}`;
}

/**
 * Internal service processing span: `service.process create-user`.
 * Use for discrete business operations in the service layer (not raw DB or HTTP).
 */
export function serviceSpanName(action: string): string {
  return `service.process ${action}`;
}

/**
 * Outbound API call span: `external.api stripe` or `external.api sendgrid`.
 * Use when making calls to third-party services.
 */
export function externalSpanName(service: string): string {
  return `external.api ${service}`;
}
