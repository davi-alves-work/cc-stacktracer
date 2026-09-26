import type { SdkSpanRow } from '../span-payload.types.js';

/**
 * Enquadra a linha nos limites do `spanV4RowSchema` do servidor antes do envio.
 *
 * O servidor valida o LOTE: uma linha fora do contrato (um `span_name` de 2 KB vindo de `withSpan`, um
 * status 999 de uma API externa) devolvia 400, e o SDK descartava os outros spans do lote como erro
 * permanente. Cortar aqui preserva a linha e o lote.
 */
const STRING_LIMITS = {
  span_name: 1024,
  service_name: 512,
  service_version: 256,
  environment: 256,
  http_method: 32,
  http_route: 4096,
  db_system: 128,
  db_operation: 512,
  db_table: 256,
  error_type: 512,
  error_message: 16_000,
  trace_flags: 64,
} as const satisfies Partial<Record<keyof SdkSpanRow, number>>;

export function sanitizeSpanRow(row: SdkSpanRow): SdkSpanRow {
  const out: Record<string, unknown> = { ...row };
  for (const [key, max] of Object.entries(STRING_LIMITS)) {
    const value = out[key];
    if (typeof value === 'string' && value.length > max) out[key] = value.slice(0, max);
  }
  const status = row.http_status_code;
  if (typeof status === 'number' && !(Number.isInteger(status) && status >= 100 && status <= 599)) {
    out.http_status_code = null;
  }
  return out as SdkSpanRow;
}
