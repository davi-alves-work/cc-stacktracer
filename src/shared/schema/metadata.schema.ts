import { z } from 'zod';
import { BusinessSchema } from './business.schema.js';
import { DbSchema } from './db.schema.js';
import { HttpSchema } from './http.schema.js';
import { ResourceSchema } from './resource.schema.js';
import { RuntimeSchema } from './runtime.schema.js';
import { TagsSchema } from './tags.schema.js';
import { iso8601TimestampSchema } from './timestamp.schema.js';
import { UserSchema } from './user.schema.js';

/**
 * Collector-added metadata merged at ingest (`enrichCanonicalEvent` / stream replay).
 */
export const IngestionMetadataSchema = z
  .object({
    region: z.string().max(256).optional(),
    ingested_at: iso8601TimestampSchema.optional(),
    environment: z.string().max(256).optional(),
    server: z
      .object({
        hostname: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CorrelationSchema = z
  .object({
    request_id: z.string().min(1).max(2048).optional(),
    requestId: z.string().min(1).max(2048).optional(),
    trace_id: z.string().min(1).max(2048).optional(),
    traceId: z.string().min(1).max(2048).optional(),
    span_id: z.string().min(1).max(2048).optional(),
    spanId: z.string().min(1).max(2048).optional(),
    parent_span_id: z.string().min(1).max(2048).optional(),
    parentSpanId: z.string().min(1).max(2048).optional(),
  })
  .passthrough();

/**
 * Structured domain metadata — replaces loose `Record<string, unknown>` on v1 for analytics-safe typing.
 */
export const MetadataSchema = z
  .object({
    http: HttpSchema.optional(),
    db: DbSchema.optional(),
    business: BusinessSchema.optional(),
    runtime: RuntimeSchema.optional(),
    resource: ResourceSchema.optional(),
    tags: TagsSchema.optional(),
    /** Bridge from v1 queue block when present. */
    queue: z
      .object({
        name: z.string().max(512).optional(),
        duration_ms: z.number().nonnegative().optional(),
      })
      .optional(),
    correlation: CorrelationSchema.optional(),
    /** Identidade do usuario final da aplicacao do cliente (SDK: setUser). */
    user: UserSchema.optional(),
    /**
     * Tenant da aplicacao do cliente — a "PM Peruibe" dentro da "Ouvidoria".
     *
     * NAO ha API de SDK para isto: e campo OPCIONAL de payload, preenchido pelo cliente em cada
     * envio (`captureError(err, { subtenant })` ou `withSpan(nome, { attributes: { subtenant } })`).
     * O servidor tambem aceita o valor chegando como tag — ver `extractSubtenant` nos writers.
     *
     * NAO confundir com `tenant_id`, que e a organizacao dona da API key. Este e o recorte de dados
     * do cliente dentro do proprio projeto dele: dimensao de filtro nas telas de investigacao, nunca
     * escopo de acesso.
     */
    subtenant: z.string().min(1).max(256).optional(),
    /** Ingestion API / worker merge — must match {@link IngestionMetadataSchema}. */
    ingestion: IngestionMetadataSchema.optional(),
    /** Capture policy: exempt from sampling when true. */
    critical: z.boolean().optional(),
    capture_critical: z.boolean().optional(),
  })
  .strict();
