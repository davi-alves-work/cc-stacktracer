/**
 * Outcome fields of the root HTTP span, shared by the fastify/adonis/express integrations so the
 * abort semantics live in one place. An aborted connection is a transport fact (`http_aborted`),
 * not an operation failure: it must not force `status: 'error'` — the server classifies aborts
 * from the flag (spec: docs/superpowers/specs/2026-07-21-abort-error-classification-design.md).
 * `http_status_code` stays null on abort: no status was delivered to the client, and preserving
 * the framework's in-flight value would often record a default 200 nobody decided.
 */
export function httpRootSpanOutcome(
  aborted: boolean,
  statusCode: number,
): {
  status: 'ok' | 'error';
  http_status_code: number | null;
  http_aborted: boolean;
  error_type: null;
  error_message: string | null;
} {
  return {
    status: statusCode >= 500 ? 'error' : 'ok',
    http_status_code: aborted ? null : statusCode,
    http_aborted: aborted,
    error_type: null,
    error_message: aborted ? 'Client closed request before the response finished' : null,
  };
}
