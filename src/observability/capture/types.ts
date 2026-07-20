/**
 * Context for {@link CaptureGate.shouldCapture}. Optional fields fall back to the client
 * `init` service name / environment where applicable.
 *
 * **`critical`**: when `true` on an error, capture is forced (evaluated before dynamic rules
 * when `enabled` is true).
 */
export type CaptureContext = {
  service_name?: string | undefined;
  environment?: string | undefined;
  endpoint?: string | undefined;
  status_code?: number | undefined;
  user_id?: string | undefined;
  critical?: boolean | undefined;
  /** For `eventType === 'span'` rule matching (SDK span rows). */
  span_type?: string | null | undefined;
};
