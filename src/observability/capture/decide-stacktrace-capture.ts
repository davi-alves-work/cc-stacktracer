import { evaluateCapture, type CaptureEventType, type CompiledCapturePolicy } from '../../shared/schema/index.js';
import type { StackTraceEvent } from '../../core/stacktrace-event.types.js';

function eventToCaptureType(event: StackTraceEvent): CaptureEventType {
  switch (event.type) {
    case 'error':
      return 'error';
    case 'log':
      return 'log';
    default:
      return 'log';
  }
}

/**
 * Pure capture decision for SDK {@link StackTraceEvent} + a compiled policy.
 * Used by {@link CaptureGate} and {@link isEventAllowedByCapturePolicy}.
 */
export function decideStackTraceCapture(
  event: StackTraceEvent,
  compiled: CompiledCapturePolicy,
  rng: () => number = Math.random,
): boolean {
  const ctx = event.context;
  const eventType = eventToCaptureType(event);
  const http = typeof ctx?.http === 'object' && ctx?.http !== null ? (ctx.http as Record<string, unknown>) : undefined;
  // Mesma chave de endpoint que spans e servidor usam: o template da rota, e o path so na falta dele.
  // A URL crua (com query) nunca casava regra nenhuma por rota.
  const endpoint =
    typeof http?.route_template === 'string'
      ? http.route_template
      : typeof http?.url === 'string'
        ? (http.url.split('?')[0] ?? http.url)
        : undefined;
  // O contexto do SDK chama de `response_status_code`; `status_code` e o nome no fio (v4).
  const rawStatus = http?.response_status_code ?? http?.status_code;
  const status_code = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : undefined;
  const critical =
    (ctx !== undefined && (ctx.critical === true || ctx.capture_critical === true)) ||
    (status_code !== undefined && status_code >= 500);

  return evaluateCapture(
    compiled,
    eventType,
    {
      service_name: event.service.name,
      ...(endpoint !== undefined && endpoint !== '' ? { endpoint } : {}),
      ...(status_code !== undefined ? { status_code } : {}),
      ...(critical ? { critical: true } : {}),
    },
    { random: rng },
  );
}
