/**
 * Capture policy parsing compiles JSONB / API payloads into {@link CapturePolicy}
 * ({@link CompiledCapturePolicy}) for synchronous evaluation. Legacy flat keys and V2
 * `{ enabled, defaultCapture, rules }` are both accepted by the internal shared schema.
 */
export {
  capturePolicyLegacyWireSchema,
  capturePolicyV2WireSchema,
  captureRuleSchema,
  compileCapturePolicy,
  DEFAULT_COMPILED_CAPTURE_POLICY,
  parseAndCompileCapturePolicy,
} from '../shared/schema/index.js';

export type {
  CaptureEventType,
  CapturePolicyLegacyWire,
  CapturePolicyV2Wire,
  CaptureRule,
  CompiledCapturePolicy as CapturePolicy,
} from '../shared/schema/index.js';

import { DEFAULT_COMPILED_CAPTURE_POLICY, parseAndCompileCapturePolicy } from '../shared/schema/index.js';

/** @deprecated Use {@link parseAndCompileCapturePolicy} — alias kept for call sites. */
export const parseCapturePolicyJson = parseAndCompileCapturePolicy;

/** Compiled policy with all capture types allowed (permissive). */
export const DEFAULT_CAPTURE_POLICY = DEFAULT_COMPILED_CAPTURE_POLICY;
