import type { z } from 'zod';
import { BusinessSchema } from '../schema/business.schema.js';
import { DbSchema } from '../schema/db.schema.js';
import { EventSchemaV4, type EventV4, W3C_SPAN_ID_RE, W3C_TRACE_ID_RE } from '../schema/canonical-event-v4.schema.js';
import type { CanonicalInput } from '../schema/event.schema.js';
import { HttpSchema } from '../schema/http.schema.js';
import { MetadataSchema } from '../schema/metadata.schema.js';
import { maskDynamicRouteSegments, routeHasRawDynamicSegments } from '../schema/route-validation.js';
import { coerceToCanonicalInput, type NormalizeOptions } from '../schema/normalize.js';

/** UUID v4 hex without dashes for span_id fallback (16 chars). */
function generateSpanId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Prefer a normalized route template when the concrete route still has raw ids (numeric/UUID segments).
 */
function pathnameFromHttpUrl(url: string): string | undefined {
  try {
    return new URL(url, 'http://localhost.local').pathname;
  } catch {
    return undefined;
  }
}

export function pickV3HttpRoute(h: NonNullable<CanonicalInput['http']>): string {
  const raw = h.route ?? h.route_template;
  if (raw === undefined || raw.trim() === '') {
    const fromUrlOnly = h.url !== undefined && h.url.trim() !== '' ? pathnameFromHttpUrl(h.url) : undefined;
    if (fromUrlOnly !== undefined && fromUrlOnly !== '') {
      const masked = maskDynamicRouteSegments(fromUrlOnly);
      if (!routeHasRawDynamicSegments(masked)) {
        return masked;
      }
    }
    return '/';
  }
  if (!routeHasRawDynamicSegments(raw)) {
    return raw;
  }
  const tmpl = h.route_template;
  if (tmpl !== undefined && tmpl.trim() !== '' && !routeHasRawDynamicSegments(tmpl)) {
    return tmpl;
  }
  const masked = maskDynamicRouteSegments(raw);
  if (!routeHasRawDynamicSegments(masked)) {
    return masked;
  }
  if (h.url !== undefined && h.url.trim() !== '') {
    const path = pathnameFromHttpUrl(h.url);
    if (path !== undefined && path !== '') {
      const fromUrl = maskDynamicRouteSegments(path);
      if (!routeHasRawDynamicSegments(fromUrl)) {
        return fromUrl;
      }
    }
  }
  return '/unnormalized';
}

function v1HttpToV3(http: CanonicalInput['http'] | undefined): z.infer<typeof HttpSchema> | undefined {
  if (http === undefined) {
    return undefined;
  }
  const method = http.method ?? 'GET';
  const route = pickV3HttpRoute(http);
  const status_code = http.response_status_code ?? 0;
  const duration_ms = http.duration_ms ?? 0;
  const scheme = typeof http.scheme === 'string' && http.scheme.trim() !== '' ? http.scheme : undefined;
  const clientAddress =
    typeof http.client?.address === 'string' && http.client.address.trim() !== '' ? http.client.address : undefined;
  const userAgent =
    typeof http['user_agent.original'] === 'string' && http['user_agent.original'].trim() !== ''
      ? http['user_agent.original']
      : undefined;
  const hasSignal =
    http.method !== undefined ||
    (http.route !== undefined && http.route.trim() !== '') ||
    (http.route_template !== undefined && http.route_template.trim() !== '') ||
    http.url !== undefined ||
    http.response_status_code !== undefined ||
    http.duration_ms !== undefined ||
    scheme !== undefined ||
    clientAddress !== undefined ||
    userAgent !== undefined;
  if (!hasSignal) {
    return undefined;
  }
  return HttpSchema.parse({
    method,
    route,
    ...(http.url !== undefined ? { url: http.url } : {}),
    status_code,
    duration_ms,
    ...(scheme !== undefined ? { scheme } : {}),
    ...(clientAddress !== undefined ? { client: { address: clientAddress } } : {}),
    ...(userAgent !== undefined ? { 'user_agent.original': userAgent } : {}),
  });
}

function v1DbToV3(db: CanonicalInput['db'] | undefined): z.infer<typeof DbSchema> | undefined {
  if (db === undefined) {
    return undefined;
  }
  if (
    db.system === undefined &&
    db.operation === undefined &&
    db.table === undefined &&
    db.duration_ms === undefined &&
    db.statement === undefined &&
    db.rows === undefined
  ) {
    return undefined;
  }
  return DbSchema.parse({
    system: db.system ?? 'unknown',
    operation: db.operation ?? 'UNKNOWN',
    table: db.table ?? 'unknown',
    duration_ms: db.duration_ms ?? 0,
    ...(db.statement !== undefined ? { statement: db.statement } : {}),
    ...(db.rows !== undefined ? { rows: db.rows } : {}),
  });
}

function v1MetadataToBusiness(meta: Record<string, unknown>): z.infer<typeof BusinessSchema> | undefined {
  const b = meta.business;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    return undefined;
  }
  const p = BusinessSchema.safeParse(b);
  return p.success ? p.data : undefined;
}

function v1MetadataToCorrelation(
  meta: Record<string, unknown>,
): z.infer<typeof MetadataSchema>['correlation'] | undefined {
  const c = meta.correlation;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    return undefined;
  }
  const p = MetadataSchema.shape.correlation.safeParse(c);
  return p.success ? p.data : undefined;
}

/** Lowercase hex string of `chars` length, generated without `node:crypto` (browser-safe). */
function randomHex(chars: number): string {
  return Array.from({ length: chars }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Identidade do usuário final. Até a 2.1.x isto caía no ramo `typeof v === 'object'` abaixo e era
 * DESCARTADO via `onDroppedContextKey` — `setUser()` não chegava a lugar nenhum.
 *
 * `tenantId` vira `end_user_tenant` de propósito: é o tenant da aplicação DO CLIENTE, e o nome curto
 * seria confundido com o `tenant_id` da plataforma, que é a organização dona da API key e é injetado
 * pelo servidor.
 */
function v1MetadataToUser(
  meta: Record<string, unknown>,
): { id: string; end_user_tenant?: string; email_hash?: string } | undefined {
  const raw = meta.user;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  // Sem id não há identidade: o evento segue inteiro, só sem o bloco.
  const id = typeof rec.id === 'string' && rec.id.trim() !== '' ? rec.id : undefined;
  if (id === undefined) return undefined;
  const endUserTenant = typeof rec.tenantId === 'string' && rec.tenantId.trim() !== '' ? rec.tenantId : undefined;
  const emailHash = typeof rec.emailHash === 'string' && rec.emailHash.trim() !== '' ? rec.emailHash : undefined;
  return {
    id,
    ...(endUserTenant !== undefined ? { end_user_tenant: endUserTenant } : {}),
    ...(emailHash !== undefined ? { email_hash: emailHash } : {}),
  };
}

/**
 * Recorte da aplicação do cliente. Não há API de SDK para isto — é campo opcional de payload, que o
 * cliente preenche em cada envio. O servidor também aceita o valor chegando como tag, então este
 * mapeamento é higiene (evita duplicar no saco de tags), não requisito.
 */
function v1MetadataToSubtenant(meta: Record<string, unknown>): string | undefined {
  const raw = meta.subtenant;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Structured `metadata` block shared by the v3 and v4 mappers — folds the v1 top-level `http`/`db`/`queue`
 * blocks and the loose metadata keys into the strict {@link MetadataSchema} (scalar extras become `tags`).
 */
function structureMetadataFromV1Event(
  event: CanonicalInput,
  onDroppedContextKey?: (key: string) => void,
): z.infer<typeof MetadataSchema> {
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const http = v1HttpToV3(event.http);
  const db = v1DbToV3(event.db);
  const queue =
    event.queue !== undefined
      ? {
          ...(event.queue.name !== undefined ? { name: event.queue.name } : {}),
          ...(event.queue.duration_ms !== undefined ? { duration_ms: event.queue.duration_ms } : {}),
        }
      : undefined;
  const business = v1MetadataToBusiness(meta);
  const correlation = v1MetadataToCorrelation(meta);

  /** v1 `metadata` / merged `context` keys promoted to string tags (structured keys excluded). */
  const RESERVED_META_KEYS = new Set([
    'name',
    'stack',
    'business',
    'trace',
    'correlation',
    'headers',
    'http',
    'db',
    'request',
    'response',
    'queue',
    'user',
    'subtenant',
  ]);
  const metaTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (RESERVED_META_KEYS.has(k)) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      metaTags[k] = v === null ? '' : String(v);
    } else if (typeof v === 'object' && onDroppedContextKey !== undefined) {
      onDroppedContextKey(k);
    }
  }
  const mergedTags: Record<string, string> = { ...metaTags, ...(event.tags ?? {}) };

  const metadataPayload: z.infer<typeof MetadataSchema> = {};
  if (http !== undefined) {
    metadataPayload.http = http;
  }
  if (db !== undefined) {
    metadataPayload.db = db;
  }
  if (business !== undefined) {
    metadataPayload.business = business;
  }
  if (queue !== undefined && (queue.name !== undefined || queue.duration_ms !== undefined)) {
    metadataPayload.queue = queue;
  }
  if (correlation !== undefined) {
    metadataPayload.correlation = correlation;
  }
  const user = v1MetadataToUser(meta);
  if (user !== undefined) {
    metadataPayload.user = user;
  }
  const subtenant = v1MetadataToSubtenant(meta);
  if (subtenant !== undefined) {
    metadataPayload.subtenant = subtenant;
  }
  if (Object.keys(mergedTags).length > 0) {
    metadataPayload.tags = mergedTags;
  }
  return MetadataSchema.parse(metadataPayload);
}

/**
 * Maps a normalized v1 {@link Event} to strict **v4** {@link EventV4}.
 *
 * - `request`/`performance` → `log` (timing belongs to spans; v4 has no such types).
 * - trace/span ids are coerced to W3C hex (regenerated only when the source id is not already valid hex,
 *   so an inbound `traceparent` is preserved); a missing `span_id` gets a fresh 16-hex id.
 */
export function eventV1ToV4(
  event: CanonicalInput,
  opts?: {
    tenantId?: string;
    projectId?: string;
    serviceId?: string;
    onDroppedContextKey?: (key: string) => void;
  },
): EventV4 {
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const type: EventV4['type'] = event.type === 'error' ? 'error' : 'log';
  const metadata = structureMetadataFromV1Event(event, opts?.onDroppedContextKey);

  const error: EventV4['error'] =
    event.type === 'error'
      ? {
          type: typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name : 'Error',
          message: event.message,
          ...(typeof meta.stack === 'string' ? { stack: meta.stack } : {}),
        }
      : undefined;

  const rawSpan =
    event.trace.span_id !== undefined && event.trace.span_id.trim() !== '' ? event.trace.span_id : generateSpanId();
  const trace_id = W3C_TRACE_ID_RE.test(event.trace.trace_id) ? event.trace.trace_id : randomHex(32);
  const span_id = W3C_SPAN_ID_RE.test(rawSpan) ? rawSpan : randomHex(16);
  const parent =
    typeof event.trace.parent_span_id === 'string' && W3C_SPAN_ID_RE.test(event.trace.parent_span_id)
      ? event.trace.parent_span_id
      : undefined;
  const trace: EventV4['trace'] = { trace_id, span_id, ...(parent !== undefined ? { parent_span_id: parent } : {}) };

  const base: Omit<EventV4, 'tenant_id' | 'project_id'> = {
    schema_version: 4,
    service_id: opts?.serviceId ?? '',
    event_id: event.event_id,
    timestamp: event.timestamp,
    type,
    level: event.level,
    message: event.message,
    service: event.service,
    trace,
    metadata,
    ...(error !== undefined ? { error } : {}),
  };

  const withTenant =
    opts?.tenantId !== undefined && opts?.projectId !== undefined
      ? { ...base, tenant_id: opts.tenantId, project_id: opts.projectId }
      : base;

  return EventSchemaV4.parse(withTenant);
}

/**
 * Normalizes arbitrary legacy/SDK input to a validated **v4** canonical event (W3C trace ids, no `performance`).
 * v4-native: coerces input to the canonical v1 shape then maps straight to v4 ({@link eventV1ToV4}) — no v3 hop.
 */
export function normalizeEventV4(input: unknown, opts?: NormalizeOptions): EventV4 {
  const input1 = coerceToCanonicalInput(input, opts);
  const tid = opts?.tenantId;
  const pid = opts?.projectId;
  const sid = opts?.serviceId;
  const onDroppedContextKey = opts?.onDroppedContextKey;
  const dropOpt = onDroppedContextKey !== undefined ? { onDroppedContextKey } : {};
  if (tid !== undefined && pid !== undefined && tid !== '' && pid !== '') {
    return eventV1ToV4(
      input1,
      sid !== undefined && sid !== ''
        ? { tenantId: tid, projectId: pid, serviceId: sid, ...dropOpt }
        : { tenantId: tid, projectId: pid, ...dropOpt },
    );
  }
  return eventV1ToV4(input1, sid !== undefined && sid !== '' ? { serviceId: sid, ...dropOpt } : dropOpt);
}
