/**
 * Flat span row sent to `POST /v1/spans` (v4). Matches `spanV4RowSchema` in the platform contract:
 * W3C hex ids, microsecond `duration_us`, OTel `status` (replaces the `is_error` boolean),
 * and free-form `attributes` (replaces the always-null `metadata`). Spans are ClickHouse-only.
 */
export type SdkSpanRow = {
  span_timestamp: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  tenant_id?: string | null;
  project_id?: string | null;
  /** Stable dashboard services.id UUID. */
  service_id?: string | null;
  service_name?: string | null;
  service_version?: string | null;
  environment?: string | null;
  span_name?: string | null;
  span_type?: 'http' | 'db' | 'business' | 'service' | 'external' | null;
  start_time: string;
  end_time: string;
  /** Duration in microseconds (sub-millisecond precision). */
  duration_us: number;
  /** OpenTelemetry-style status. `is_error` is derived server-side from `status === 'error'`. */
  status: 'unset' | 'ok' | 'error';
  http_method?: string | null;
  http_route?: string | null;
  http_status_code?: number | null;
  /** Client disconnected before the response finished. Transport fact, not an operation failure. */
  http_aborted?: boolean;
  db_system?: string | null;
  db_operation?: string | null;
  db_table?: string | null;
  db_duration_us?: number | null;
  error_type?: string | null;
  error_message?: string | null;
  trace_flags?: string | null;
  attributes?: Record<string, unknown> | null;
};
