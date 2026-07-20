import type { CompiledCapturePolicy } from '../shared/schema/index.js';
import type { StackTraceEvent } from './stacktrace-event.types.js';
import { decideStackTraceCapture } from '../observability/capture/decide-stacktrace-capture.js';

/** @deprecated Prefer {@link CaptureGate}; kept for tests and parity with the gate. */
export function isEventAllowedByCapturePolicy(
  event: StackTraceEvent,
  policy: CompiledCapturePolicy,
  random?: () => number,
): boolean {
  return decideStackTraceCapture(event, policy, random ?? Math.random);
}
