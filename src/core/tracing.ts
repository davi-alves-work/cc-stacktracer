import { randomBytes } from 'node:crypto';
import { getSdkRuntime } from './client-ref.js';
import type { SdkSpanRow } from './span-payload.types.js';
import {
  currentParentSpanIdForChild,
  currentTraceContext,
  getTraceIdFromContext,
  popActiveSpan,
  pushActiveSpan,
} from './trace-span-context.js';
import { getBusinessContext } from './business-context.js';

export type SpanOptions = {
  type?: 'http' | 'db' | 'business' | 'service' | 'external';
  attributes?: Record<string, unknown>;
};

export type SpanHandle = { end: (err?: Error) => void };

/** W3C span id: 8 random bytes as 16 lowercase hex chars. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

function strAttr(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

function numAttr(attrs: Record<string, unknown> | undefined, key: string): number | undefined {
  if (attrs === undefined) return undefined;
  const v = attrs[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

/** Attribute keys promoted to dedicated span columns — excluded from the free-form `attributes`. */
const PROMOTED_SPAN_ATTR_KEYS = new Set<string>([
  'http_method',
  'http_route',
  'http_status_code',
  'db_system',
  'db_operation',
  'db_table',
  'db_duration_ms',
  'db_duration_us',
  'trace_flags',
]);

function spanAttributes(attrs: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (attrs === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!PROMOTED_SPAN_ATTR_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merges the active `withBusinessContext` scope (entity/operation/fields_changed) into span
 * attributes. Explicit `attributes` win on key collision — same "caller wins" rule as
 * `mergeEventContext` uses for event context (`src/core/request-context.ts`).
 */
function mergeBusinessAttributes(explicit: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const business = getBusinessContext();
  if (business === undefined) {
    return explicit;
  }
  const businessAttrs: Record<string, unknown> = {
    entity: business.entity,
    operation: business.operation,
    ...(business.fields_changed !== undefined ? { fields_changed: business.fields_changed } : {}),
  };
  return explicit === undefined ? businessAttrs : { ...businessAttrs, ...explicit };
}

function buildRow(params: {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  startIso: string;
  endIso: string;
  durationUs: number;
  /** Explicit trace id (outbound spans capture it at start); falls back to the active ALS trace. */
  traceId?: string;
  options?: SpanOptions;
  err?: Error;
}): SdkSpanRow | null {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) {
    return null;
  }
  const traceId = params.traceId ?? getTraceIdFromContext();
  if (traceId === undefined) {
    return null;
  }

  const attrs = mergeBusinessAttributes(params.options?.attributes);
  const spanType = params.options?.type ?? 'business';
  const roundedDurationUs = Math.max(0, Math.round(params.durationUs));
  const dbDurMsAttr = numAttr(attrs, 'db_duration_ms');
  const dbDurAttr =
    numAttr(attrs, 'db_duration_us') ?? (dbDurMsAttr !== undefined ? Math.round(dbDurMsAttr * 1000) : undefined);
  const db_duration_us = spanType === 'db' ? (dbDurAttr ?? roundedDurationUs) : (dbDurAttr ?? null);

  return {
    span_timestamp: params.endIso,
    trace_id: traceId,
    span_id: params.spanId,
    parent_span_id: params.parentSpanId,
    service_name: initConfig.service.name,
    service_version: initConfig.service.version,
    environment: initConfig.environment,
    span_name: params.name,
    span_type: spanType,
    start_time: params.startIso,
    end_time: params.endIso,
    duration_us: roundedDurationUs,
    status: params.err !== undefined ? 'error' : 'ok',
    http_method: strAttr(attrs, 'http_method') ?? null,
    http_route: strAttr(attrs, 'http_route') ?? null,
    http_status_code: numAttr(attrs, 'http_status_code') ?? null,
    db_system: strAttr(attrs, 'db_system') ?? null,
    db_operation: strAttr(attrs, 'db_operation') ?? null,
    db_table: strAttr(attrs, 'db_table') ?? null,
    db_duration_us,
    error_type: params.err?.name ?? null,
    error_message: params.err !== undefined ? params.err.message.slice(0, 16_000) : null,
    trace_flags: strAttr(attrs, 'trace_flags') ?? null,
    attributes: spanAttributes(attrs),
  };
}

export async function withSpan<T>(name: string, fn: () => Promise<T> | T, options?: SpanOptions): Promise<T> {
  if (getTraceIdFromContext() === undefined) {
    return Promise.resolve(fn());
  }
  const parent = currentParentSpanIdForChild() ?? null;
  const spanId = newSpanId();
  pushActiveSpan(spanId);
  const startIso = new Date().toISOString();
  const perfStart = performance.now();
  try {
    const out = await Promise.resolve(fn());
    const durationUs = (performance.now() - perfStart) * 1000;
    const endIso = new Date().toISOString();
    const row = buildRow({
      name,
      spanId,
      parentSpanId: parent,
      startIso,
      endIso,
      durationUs,
      ...(options !== undefined ? { options } : {}),
    });
    if (row !== null) {
      getSdkRuntime().client?.enqueueSpan(row);
    }
    return out;
  } catch (err) {
    const durationUs = (performance.now() - perfStart) * 1000;
    const endIso = new Date().toISOString();
    const e = err instanceof Error ? err : new Error(String(err));
    const row = buildRow({
      name,
      spanId,
      parentSpanId: parent,
      startIso,
      endIso,
      durationUs,
      ...(options !== undefined ? { options } : {}),
      err: e,
    });
    if (row !== null) {
      getSdkRuntime().client?.enqueueSpan(row);
    }
    throw err;
  } finally {
    popActiveSpan();
  }
}

export function startSpan(name: string, options?: SpanOptions): SpanHandle {
  if (getTraceIdFromContext() === undefined) {
    return { end: () => {} };
  }
  const parent = currentParentSpanIdForChild() ?? null;
  const spanId = newSpanId();
  pushActiveSpan(spanId);
  const startIso = new Date().toISOString();
  const perfStart = performance.now();
  return {
    end: (err?: Error) => {
      const durationUs = (performance.now() - perfStart) * 1000;
      const endIso = new Date().toISOString();
      const row = buildRow({
        name,
        spanId,
        parentSpanId: parent,
        startIso,
        endIso,
        durationUs,
        ...(options !== undefined ? { options } : {}),
        ...(err !== undefined ? { err } : {}),
      });
      if (row !== null) {
        getSdkRuntime().client?.enqueueSpan(row);
      }
      popActiveSpan();
    },
  };
}

export function endSpan(handle: SpanHandle, err?: Error): void {
  handle.end(err);
}

/**
 * Captured trace state for an outbound (client) span. Unlike {@link startSpan}, an outbound span is a
 * **leaf**: it is NOT pushed onto the active span stack, so concurrent in-flight calls each parent to the
 * enclosing span (the request root / current span) instead of nesting under each other.
 */
export type OutboundSpanStart = {
  traceId: string;
  /** Outbound client span id — inject this into the downstream `traceparent`. */
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
  startIso: string;
  perfStart: number;
};

/** Begins an outbound client span from the active trace, or returns `null` when no trace is active. */
export function beginOutboundSpan(): OutboundSpanStart | null {
  const ctx = currentTraceContext();
  if (ctx === undefined) {
    return null;
  }
  return {
    traceId: ctx.traceId,
    spanId: newSpanId(),
    parentSpanId: ctx.parentSpanId ?? null,
    traceFlags: ctx.traceFlags,
    startIso: new Date().toISOString(),
    perfStart: performance.now(),
  };
}

/** Finalizes and enqueues an outbound client span. Callers must guard against double-finalization. */
export function endOutboundSpan(
  begin: OutboundSpanStart,
  params: { name: string; type?: SpanOptions['type']; attributes?: Record<string, unknown>; err?: Error },
): void {
  const durationUs = (performance.now() - begin.perfStart) * 1000;
  const endIso = new Date().toISOString();
  const options: SpanOptions = {
    type: params.type ?? 'external',
    ...(params.attributes !== undefined ? { attributes: params.attributes } : {}),
  };
  const row = buildRow({
    name: params.name,
    traceId: begin.traceId,
    spanId: begin.spanId,
    parentSpanId: begin.parentSpanId,
    startIso: begin.startIso,
    endIso,
    durationUs,
    options,
    ...(params.err !== undefined ? { err: params.err } : {}),
  });
  if (row !== null) {
    getSdkRuntime().client?.enqueueSpan(row);
  }
}
