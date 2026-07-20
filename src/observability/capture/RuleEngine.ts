/**
 * Re-exports the shared capture rule engine (single source of truth for SDK + ingestion).
 * Future: swap `PolicyLoader` implementation (HTTP today, Redis pub/sub later) without changing
 * {@link evaluateCapture}.
 */
export {
  compileCapturePolicy,
  evaluateCapture,
  parseAndCompileCapturePolicy,
  spanRowToCaptureEventType,
  CAPTURE_POLICY_MAX_RULES,
  CAPTURE_POLICY_MAX_ENDPOINT_LEN,
} from '../../shared/schema/index.js';

export type {
  CaptureEvaluationContext,
  CaptureEventType,
  CompiledCapturePolicy,
  EvaluateCaptureOptions,
} from '../../shared/schema/index.js';
