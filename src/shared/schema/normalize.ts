import type { CanonicalInput } from './event.schema.js';

/** UUID v4 without `node:crypto` so the shared package can load in browser bundles (e.g. dashboard-web). */
function randomUUID(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
}
import { parseTraceparentTraceId } from './traceparent.js';

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** Optional hints from the HTTP ingest request (correlation id, trace headers). */
export type NormalizeOptions = {
  /** Used when the payload omits trace identifiers (batch ingest, SDK batch). */
  requestTraceFallback?: string;
  /** W3C `traceparent` from the HTTP request when not in the body. */
  httpTraceparent?: string;
  /** `x-request-id` from the HTTP request when not in the body. */
  httpRequestId?: string;
  /** When set with {@link projectId}, SDK/HTTP can emit schema v2 events (organization + project UUIDs). */
  tenantId?: string;
  /** When set with {@link tenantId}, SDK/HTTP can emit schema v2 events. */
  projectId?: string;
  /** Stable `services.id` UUID used by v3 ingest and SDK-generated payloads. */
  serviceId?: string;
  /**
   * Dev-diagnostic hook: called once per top-level `context`/`metadata` key whose value is an
   * object/array under a name the normalizer doesn't recognize as a structured block (`http`,
   * `db`, `business`, `correlation`, `queue`, ...) — that value is silently NOT sent otherwise.
   * Wire this to a logger to catch mistakes like `captureException(err, { context: {...} })`
   * (double-wrapped) during development.
   */
  onDroppedContextKey?: (key: string) => void;
};

function pickMessage(o: Record<string, unknown>): string {
  const m = o.message ?? o.msg;
  if (typeof m === 'string' && m.length > 0) return m;
  return '(empty message)';
}

function pickTimestamp(o: Record<string, unknown>): string {
  const t = o.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) {
    return new Date(t > 1e12 ? t : t * 1000).toISOString();
  }
  if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) {
    return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function normalizeVersionString(v: string | undefined): string {
  if (v === undefined || v.trim() === '') return 'unknown';
  return v;
}

function pickService(o: Record<string, unknown>): { name: string; version: string; environment: string } {
  const nested = asRecord(o.service);
  if (nested !== null && typeof nested.name === 'string') {
    return {
      name: nested.name,
      version: normalizeVersionString(typeof nested.version === 'string' ? nested.version : undefined),
      environment: typeof nested.environment === 'string' ? nested.environment : 'unknown',
    };
  }
  const name = typeof o.service === 'string' ? o.service : 'unknown';
  const env = typeof o.environment === 'string' ? o.environment : 'unknown';
  const rawVersion =
    (typeof o.release === 'string' ? o.release : undefined) ??
    (typeof o.version === 'string' ? o.version : undefined) ??
    '';
  return { name, version: normalizeVersionString(rawVersion), environment: env };
}

function getLegacyContextOrMetadata(o: Record<string, unknown>): Record<string, unknown> {
  const ctx = asRecord(o.context);
  const meta = asRecord(o.metadata);
  if (ctx !== null) return { ...ctx };
  if (meta !== null) return { ...meta };
  return {};
}

function getHeaderCaseInsensitive(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.trim() !== '') {
      return v.trim();
    }
  }
  return undefined;
}

function pickTraceId(meta: Record<string, unknown>, o: Record<string, unknown>, opts?: NormalizeOptions): string {
  const tr = asRecord(meta.trace);
  const corr = asRecord(meta.correlation);
  const fromTrace =
    (typeof tr?.trace_id === 'string' && tr.trace_id.trim() !== '' ? tr.trace_id.trim() : undefined) ??
    (typeof tr?.traceId === 'string' && tr.traceId.trim() !== '' ? tr.traceId.trim() : undefined);
  const fromCorr = typeof corr?.traceId === 'string' && corr.traceId.trim() !== '' ? corr.traceId.trim() : undefined;
  if (fromTrace !== undefined) return fromTrace;
  if (fromCorr !== undefined) return fromCorr;

  const headers = asRecord(meta.headers);
  if (headers !== null) {
    const tp = getHeaderCaseInsensitive(headers, 'traceparent');
    const tid = parseTraceparentTraceId(tp);
    if (tid !== undefined) return tid;
    const xr =
      getHeaderCaseInsensitive(headers, 'x-request-id') ?? getHeaderCaseInsensitive(headers, 'x-correlation-id');
    if (xr !== undefined) return xr;
  }

  const tidOpt = parseTraceparentTraceId(opts?.httpTraceparent);
  if (tidOpt !== undefined) return tidOpt;
  if (typeof opts?.httpRequestId === 'string' && opts.httpRequestId.trim() !== '') {
    return opts.httpRequestId.trim();
  }

  const topLevel = typeof o.trace_id === 'string' && o.trace_id.trim() !== '' ? o.trace_id.trim() : undefined;
  if (topLevel !== undefined) return topLevel;

  if (typeof opts?.requestTraceFallback === 'string' && opts.requestTraceFallback.trim() !== '') {
    return opts.requestTraceFallback.trim();
  }

  return randomUUID();
}

function pickSpanIds(meta: Record<string, unknown>): { span_id?: string; parent_span_id?: string } {
  const tr = asRecord(meta.trace);
  if (tr === null) return {};
  const span_id = typeof tr.span_id === 'string' ? tr.span_id : undefined;
  const parent_span_id = typeof tr.parent_span_id === 'string' ? tr.parent_span_id : undefined;
  return { ...(span_id !== undefined ? { span_id } : {}), ...(parent_span_id !== undefined ? { parent_span_id } : {}) };
}

function pickUser(meta: Record<string, unknown>): CanonicalInput['user'] | undefined {
  const u = asRecord(meta.user);
  if (u === null) return undefined;
  const id = typeof u.id === 'string' ? u.id : undefined;
  const email = typeof u.email === 'string' ? u.email : undefined;
  if (id === undefined && email === undefined) return undefined;
  return { ...(id !== undefined ? { id } : {}), ...(email !== undefined ? { email } : {}) };
}

function pickTags(meta: Record<string, unknown>): Record<string, string> | undefined {
  const t = meta.tags;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripReserved(meta: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...meta };
  delete rest.trace;
  delete rest.user;
  delete rest.tags;
  delete rest.http;
  delete rest.db;
  delete rest.queue;
  delete rest.headers;
  return rest;
}

function firstFiniteNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return undefined;
}

function pathnameFromUrl(url: string): string {
  try {
    return new URL(url, 'http://localhost.local').pathname;
  } catch {
    return url;
  }
}

/**
 * Merges HTTP fields from legacy metadata (nested http, request/response, aliases) into an optional base.
 */
function mergeHttpFromLegacy(
  base: CanonicalInput['http'] | undefined,
  meta: Record<string, unknown>,
): CanonicalInput['http'] | undefined {
  const nestedHttp = asRecord(meta.http);
  const legacyResp = asRecord(meta.response);
  const legacyReq = asRecord(meta.request);

  const duration_ms = firstFiniteNumber(
    base?.duration_ms,
    nestedHttp !== null ? nestedHttp.duration_ms : undefined,
    nestedHttp !== null ? nestedHttp.durationMs : undefined,
    legacyResp !== null ? legacyResp.durationMs : undefined,
    legacyResp !== null ? legacyResp.duration_ms : undefined,
  );

  const response_status_code = firstFiniteNumber(
    base?.response_status_code,
    nestedHttp !== null ? nestedHttp.response_status_code : undefined,
    nestedHttp !== null ? nestedHttp.status_code : undefined,
    nestedHttp !== null ? nestedHttp.statusCode : undefined,
    legacyResp !== null ? legacyResp.statusCode : undefined,
    legacyResp !== null ? legacyResp.status_code : undefined,
  );

  const method = firstNonEmptyString(
    base?.method,
    nestedHttp !== null ? nestedHttp.method : undefined,
    legacyReq !== null ? legacyReq.method : undefined,
  );

  const route = firstNonEmptyString(base?.route, nestedHttp !== null ? nestedHttp.route : undefined);

  const route_template = firstNonEmptyString(
    base?.route_template,
    nestedHttp !== null ? nestedHttp.route_template : undefined,
  );

  const url = firstNonEmptyString(
    base?.url,
    nestedHttp !== null ? nestedHttp.url : undefined,
    legacyReq !== null ? legacyReq.url : undefined,
  );

  const scheme = firstNonEmptyString(base?.scheme, nestedHttp !== null ? nestedHttp.scheme : undefined);

  const nestedHttpClient =
    nestedHttp !== null && typeof nestedHttp.client === 'object' && nestedHttp.client !== null
      ? (nestedHttp.client as Record<string, unknown>)
      : null;
  const clientAddress = firstNonEmptyString(
    base?.client?.address,
    nestedHttp !== null ? (nestedHttp['client.address'] as unknown) : undefined,
    nestedHttpClient !== null ? nestedHttpClient.address : undefined,
  );

  const userAgent = firstNonEmptyString(
    base?.['user_agent.original'],
    nestedHttp !== null ? (nestedHttp['user_agent.original'] as unknown) : undefined,
  );

  if (
    method === undefined &&
    route === undefined &&
    route_template === undefined &&
    url === undefined &&
    scheme === undefined &&
    clientAddress === undefined &&
    userAgent === undefined &&
    duration_ms === undefined &&
    response_status_code === undefined
  ) {
    return undefined;
  }

  return {
    ...(method !== undefined ? { method } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(route_template !== undefined ? { route_template } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
    ...(clientAddress !== undefined ? { client: { address: clientAddress } } : {}),
    ...(userAgent !== undefined ? { 'user_agent.original': userAgent } : {}),
    ...(response_status_code !== undefined ? { response_status_code } : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
  };
}

function mergeDbFromLegacy(
  meta: Record<string, unknown>,
  explicit?: CanonicalInput['db'],
): CanonicalInput['db'] | undefined {
  const nested = asRecord(meta.db);
  const system =
    explicit?.system ??
    (nested !== null && typeof nested.system === 'string' ? nested.system : undefined) ??
    (nested !== null && typeof nested.db_type === 'string' ? nested.db_type : undefined) ??
    (nested !== null && typeof nested.dbType === 'string' ? nested.dbType : undefined);
  const operation =
    explicit?.operation ??
    (nested !== null && typeof nested.operation === 'string' ? nested.operation : undefined) ??
    (nested !== null && typeof nested.op === 'string' ? nested.op : undefined) ??
    (nested !== null && typeof nested.operationName === 'string' ? nested.operationName : undefined);
  const table = explicit?.table ?? (nested !== null && typeof nested.table === 'string' ? nested.table : undefined);
  const duration_ms =
    explicit?.duration_ms ??
    (nested !== null && typeof nested.duration_ms === 'number' ? nested.duration_ms : undefined) ??
    (nested !== null && typeof nested.durationMs === 'number' ? nested.durationMs : undefined);
  const statement =
    explicit?.statement ?? (nested !== null && typeof nested.statement === 'string' ? nested.statement : undefined);
  const rows =
    explicit?.rows ??
    (nested !== null && typeof nested.rows === 'number' && Number.isInteger(nested.rows) && nested.rows >= 0
      ? nested.rows
      : undefined);
  if (
    system === undefined &&
    operation === undefined &&
    table === undefined &&
    duration_ms === undefined &&
    statement === undefined &&
    rows === undefined
  ) {
    return undefined;
  }
  return {
    ...(system !== undefined ? { system } : {}),
    ...(operation !== undefined ? { operation } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
    ...(statement !== undefined ? { statement } : {}),
    ...(rows !== undefined ? { rows } : {}),
  };
}

function mergeQueueFromLegacy(
  meta: Record<string, unknown>,
  explicit?: CanonicalInput['queue'],
): CanonicalInput['queue'] | undefined {
  const nested = asRecord(meta.queue);
  const name = explicit?.name ?? (nested !== null && typeof nested.name === 'string' ? nested.name : undefined);
  const duration_ms =
    explicit?.duration_ms ??
    (nested !== null && typeof nested.duration_ms === 'number' ? nested.duration_ms : undefined) ??
    (nested !== null && typeof nested.durationMs === 'number' ? nested.durationMs : undefined);
  if (name === undefined && duration_ms === undefined) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
  };
}

/** v4 has only `log | error`; everything that isn't an error coerces to a log. */
function inferLegacyType(o: Record<string, unknown>): CanonicalInput['type'] {
  return o.type === 'error' ? 'error' : 'log';
}

function inferLevel(
  type: CanonicalInput['type'],
  o: Record<string, unknown>,
  meta: Record<string, unknown>,
): CanonicalInput['level'] {
  const lvl = o.level ?? meta.level;
  if (lvl === 'trace' || lvl === 'debug' || lvl === 'info' || lvl === 'warn' || lvl === 'error' || lvl === 'fatal') {
    return lvl;
  }
  if (type === 'error') return 'error';
  return 'info';
}

function finalizeServiceAndHttp<T extends CanonicalInput>(event: T): T {
  let service = event.service;
  if (service.version === '') {
    service = { ...service, version: 'unknown' };
  }

  let http = event.http;
  if (http !== undefined) {
    const method = http.method;
    const url = http.url;
    const routeEmpty = http.route === undefined || (typeof http.route === 'string' && http.route.trim() === '');
    const hasTemplate = typeof http.route_template === 'string' && http.route_template.trim() !== '';
    if (routeEmpty && !hasTemplate && method !== undefined && url !== undefined) {
      http = { ...http, route: `${method} ${pathnameFromUrl(url)}` };
    }
  }

  return { ...event, service, ...(http !== undefined ? { http } : {}) } as T;
}

/**
 * Coerces raw SDK / legacy input into the intermediate {@link CanonicalInput} shape (service/trace/metadata
 * blocks). No Zod validation here — {@link normalizeEventV4} maps the result to canonical v4 and the final
 * {@link EventSchemaV4} parse validates the wire payload.
 */
export function coerceToCanonicalInput(input: unknown, opts?: NormalizeOptions): CanonicalInput {
  const o = asRecord(input);
  if (o === null) {
    throw new TypeError('coerceToCanonicalInput: expected object');
  }

  const meta = getLegacyContextOrMetadata(o);
  const service = pickService(o);
  const trace_id = pickTraceId(meta, o, opts);
  const trace: CanonicalInput['trace'] = { trace_id, ...pickSpanIds(meta) };

  const type = inferLegacyType(o);
  const level = inferLevel(type, o, meta);
  const http = mergeHttpFromLegacy(undefined, meta);
  const message = pickMessage(o);

  const db = mergeDbFromLegacy(meta);
  const queue = mergeQueueFromLegacy(meta);
  const user = pickUser(meta);
  const tags = pickTags(meta);

  let metadata = stripReserved(meta);
  if (type === 'error') {
    const stack = typeof o.stack === 'string' ? o.stack : undefined;
    const name = typeof o.name === 'string' ? o.name : undefined;
    metadata = { ...metadata, ...(stack !== undefined ? { stack } : {}), ...(name !== undefined ? { name } : {}) };
  }

  const event: CanonicalInput = {
    event_id: randomUUID(),
    timestamp: pickTimestamp(o),
    type,
    level,
    message,
    service,
    trace,
    ...(http !== undefined ? { http } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(queue !== undefined ? { queue } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  return finalizeServiceAndHttp(event);
}
