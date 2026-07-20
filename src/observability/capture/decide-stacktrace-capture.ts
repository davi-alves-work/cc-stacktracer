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
  const endpoint =
    typeof ctx?.http === 'object' && ctx?.http !== null && 'url' in (ctx.http as object)
      ? String((ctx.http as { url?: string }).url ?? '')
      : undefined;
  const rawStatus =
    typeof ctx?.http === 'object' && ctx?.http !== null
      ? (ctx.http as { status_code?: unknown }).status_code
      : undefined;
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
