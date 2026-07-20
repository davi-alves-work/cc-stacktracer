import { z } from 'zod';
import { ServiceSchema } from './service.schema.js';

export { iso8601TimestampSchema } from './timestamp.schema.js';
export { ServiceSchema } from './service.schema.js';

const MAX_DB_STATEMENT = 500;

export const TraceSchema = z.object({
  trace_id: z.string().min(1).max(256),
  span_id: z.string().max(128).optional(),
  parent_span_id: z.string().max(128).optional(),
});

/** HTTP fields use snake_case; `response_status_code` is the HTTP response status. */
export const HttpBlockSchema = z.object({
  method: z.string().max(32).optional(),
  route: z.string().max(2048).optional(),
  /** Framework route pattern for low-cardinality rollups (e.g. `/api/users/:id`). */
  route_template: z.string().max(2048).optional(),
  url: z.string().max(8192).optional(),
  response_status_code: z.number().int().optional(),
  duration_ms: z.number().optional(),
  scheme: z.string().max(32).optional(),
  client: z
    .object({
      address: z.string().max(2048).optional(),
    })
    .optional(),
  'user_agent.original': z.string().max(2048).optional(),
});

export const DbBlockSchema = z.object({
  system: z.string().max(128).optional(),
  operation: z.string().max(512).optional(),
  /** SQL table name when known (optional). */
  table: z.string().max(256).optional(),
  duration_ms: z.number().optional(),
  statement: z
    .preprocess(
      (val) => (typeof val === 'string' ? val.slice(0, MAX_DB_STATEMENT) : val),
      z.string().max(MAX_DB_STATEMENT),
    )
    .optional(),
  rows: z.number().int().nonnegative().optional(),
});

export const QueueBlockSchema = z.object({
  name: z.string().max(512).optional(),
  duration_ms: z.number().optional(),
});

/** `email` is reserved for opaque identifiers (e.g. hash); never raw PII unless you explicitly choose to send it. */
export const UserBlockSchema = z.object({
  id: z.string().max(256).optional(),
  email: z.string().max(512).optional(),
});

export const EventLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** SDK-internal event kinds produced by the builders before coercion to canonical v4. */
export const EventTypeSchema = z.enum(['error', 'log']);

/**
 * Intermediate shape the SDK coerces raw builder/legacy input into, before mapping to canonical v4
 * ({@link normalizeEventV4}). Mirrors the old v1 `Event` fields without the `schema_version` brand or a
 * strict Zod parse — the final {@link EventSchemaV4} parse validates the wire payload.
 */
export type CanonicalInput = {
  event_id: string;
  timestamp: string;
  type: z.infer<typeof EventTypeSchema>;
  level: z.infer<typeof EventLevelSchema>;
  message: string;
  service: z.infer<typeof ServiceSchema>;
  trace: z.infer<typeof TraceSchema>;
  http?: z.infer<typeof HttpBlockSchema>;
  db?: z.infer<typeof DbBlockSchema>;
  queue?: z.infer<typeof QueueBlockSchema>;
  user?: z.infer<typeof UserBlockSchema>;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
};
