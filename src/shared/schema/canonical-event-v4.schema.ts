import { z } from 'zod';
import { ErrorSchema } from './error.schema.js';
import { EventLevelSchema } from './event.schema.js';
import { MetadataSchema } from './metadata.schema.js';
import { ServiceSchema } from './service.schema.js';
import { iso8601TimestampSchema } from './timestamp.schema.js';

/**
 * W3C trace-context id formats (lowercase hex). Replaces the loose strings used in v1–v3,
 * so trace/span ids reconcile with incoming `traceparent` headers and cross-service joins.
 */
export const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/u;
export const W3C_SPAN_ID_RE = /^[0-9a-f]{16}$/u;

export const w3cTraceId = z.string().regex(W3C_TRACE_ID_RE, 'trace_id must be 32 lowercase hex chars (W3C)');
export const w3cSpanId = z.string().regex(W3C_SPAN_ID_RE, 'span_id must be 16 lowercase hex chars (W3C)');

/** v4 event kinds — `performance` from v3 is removed; timing belongs to spans. */
export const EventTypeV4Schema = z.enum(['log', 'error']);

/** Distributed tracing correlation (W3C hex) — required in canonical v4. */
export const TraceSchemaV4 = z.object({
  trace_id: w3cTraceId,
  span_id: w3cSpanId,
  parent_span_id: w3cSpanId.nullable().optional(),
});

/**
 * Canonical platform event (v4): strict wire + persistence contract. Single source of truth.
 * snake_case throughout; `service_id` is identity; `tenant_id`/`project_id` injected by the API key.
 */
export const EventSchemaV4 = z
  .object({
    schema_version: z.literal(4),
    service_id: z.string().uuid(),
    tenant_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    event_id: z.string().uuid(),
    timestamp: iso8601TimestampSchema,
    type: EventTypeV4Schema,
    level: EventLevelSchema,
    message: z.string().min(1).max(64_000),
    service: ServiceSchema,
    trace: TraceSchemaV4,
    metadata: MetadataSchema.default({}),
    error: ErrorSchema.optional(),
  })
  .strict();

export type EventV4 = z.infer<typeof EventSchemaV4>;
