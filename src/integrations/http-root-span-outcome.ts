import { getErrorTrackingConfig } from '../core/error-tracking-config.js';

/**
 * Outcome fields of the root HTTP span, shared by the fastify/adonis/express/generic-http integrations.
 *
 * Status, no modelo do Datadog (`addStatusError` do dd-trace-js): a requisicao e erro so quando o status
 * esta nas faixas de erro de servidor (padrao 500-599, `httpServerErrorStatuses`). A excecao vista na borda
 * so entra no span nesse caso — um 404 lancado como excecao nao e erro de servidor.
 *
 * An aborted connection is a transport fact (`http_aborted`), not an operation failure: it must not force
 * `status: 'error'` — the server classifies aborts from the flag (spec:
 * docs/superpowers/specs/2026-07-21-abort-error-classification-design.md). `http_status_code` stays null on
 * abort: no status was delivered to the client.
 */
export function httpRootSpanOutcome(
  aborted: boolean,
  statusCode: number,
  error?: Error,
): {
  status: 'ok' | 'error';
  http_status_code: number | null;
  http_aborted: boolean;
  error_type: string | null;
  error_message: string | null;
} {
  // O abort nao apaga um 5xx ja decidido: os dois fatos ficam (status de erro E http_aborted).
  const serverError = getErrorTrackingConfig().isServerErrorStatus(statusCode);
  const attached = serverError ? error : undefined;
  return {
    status: serverError ? 'error' : 'ok',
    http_status_code: aborted ? null : statusCode,
    http_aborted: aborted,
    error_type: attached !== undefined ? (typeof attached.name === 'string' ? attached.name : 'Error') : null,
    error_message: aborted
      ? 'Client closed request before the response finished'
      : attached !== undefined
        ? String(attached.message).slice(0, 16_000)
        : null,
  };
}
