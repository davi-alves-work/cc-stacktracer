import type { StackTraceEvent } from './stacktrace-event.types.js';

/**
 * Partial wire shape before `normalizeEvent` → strict v3 on the default HTTP transport (`metadata` instead of SDK `context`).
 * Custom transports receive internal `StackTraceEvent` with `context`.
 */
export function toWirePayloadForIngest(event: StackTraceEvent): Record<string, unknown> {
  const { context, ...rest } = event as unknown as Record<string, unknown> & { context?: Record<string, unknown> };
  const out: Record<string, unknown> = { ...rest };
  if (context !== undefined && Object.keys(context).length > 0) {
    out.metadata = context;
  }
  return out;
}
