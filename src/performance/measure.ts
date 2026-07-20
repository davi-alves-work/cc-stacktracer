import { buildErrorEvent } from '../capture/build-error-event.js';
import { getSdkRuntime } from '../core/client-ref.js';
import { beginOutboundSpan, endOutboundSpan, withSpan } from '../core/tracing.js';
import { extractSqlVerb } from './sql-verb.js';

export { extractSqlVerb } from './sql-verb.js';

export type MeasureKind = 'db' | 'http' | 'queue' | 'internal';

export type MeasureOptions = {
  kind?: MeasureKind;
  /** When kind is `db`, e.g. `mssql`, `postgres`. */
  dbSystem?: string;
  /** When true, success path does not emit a span (errors still captured). */
  silent?: boolean;
  /** When kind is `db`, optional table name (e.g. from `runQuery` options). */
  dbTable?: string;
  /** Raw SQL used to infer verb (`SELECT`, `UPDATE`, …) when `dbSqlVerb` is not set. */
  dbSql?: string;
  /** Override SQL verb for `db.operation` (e.g. `UPDATE`). */
  dbSqlVerb?: string;
  /** Extra span attributes merged in last — lands in `metadata_json`. */
  attributes?: Record<string, unknown>;
};

/** Optional enrichment for {@link runQuery}. */
export type RunQueryOptions = {
  table?: string;
  /** Raw SQL — first keyword used for `db.operation` when `sqlVerb` is omitted. */
  sql?: string;
  /** Explicit SQL verb (e.g. `UPDATE`) when `sql` is not available. */
  sqlVerb?: string;
  /** When false, failures are not auto-enqueued as error events (use when the app captures at the HTTP boundary). Default true. */
  captureError?: boolean;
  /**
   * When true, the span is a leaf — it never becomes the parent of spans started while the query
   * is in flight, so concurrent queries each parent to the enclosing span instead of nesting
   * under each other. Default false (callers may intentionally nest work under the span).
   */
  leaf?: boolean;
  /**
   * Extra span attributes merged in last — lands in `metadata_json`. Overrides `db_system`/
   * `db_operation`/`db_table` if the same key names are used explicitly (rare, intentional).
   */
  attributes?: Record<string, unknown>;
};

function kindToSpanType(kind: MeasureKind): 'db' | 'http' | 'external' | 'business' {
  if (kind === 'db') return 'db';
  if (kind === 'http') return 'http';
  if (kind === 'queue') return 'external';
  return 'business';
}

/**
 * Runs `fn`, records duration as a **span** (no success log). On failure, captures an error event and rethrows.
 */
export async function measure<T>(operation: string, fn: () => Promise<T> | T, options?: MeasureOptions): Promise<T> {
  const kind = options?.kind ?? 'internal';
  const spanType = kindToSpanType(kind);
  const { client, initConfig } = getSdkRuntime();
  const start = performance.now();
  try {
    const run = async (): Promise<T> => {
      const result = await Promise.resolve(fn());
      return result;
    };

    if (options?.silent) {
      return await run();
    }

    const attrs: Record<string, unknown> = {};
    if (kind === 'db') {
      const sqlVerb = options?.dbSqlVerb ?? extractSqlVerb(options?.dbSql);
      attrs.db_system = options?.dbSystem ?? 'unknown';
      attrs.db_operation = sqlVerb ?? operation;
      if (options?.dbTable !== undefined) attrs.db_table = options.dbTable;
    }
    if (kind === 'http') {
      attrs.http_route = operation;
    }
    if (kind === 'queue') {
      attrs.metadata_hint = operation;
    }
    if (options?.attributes !== undefined) {
      Object.assign(attrs, options.attributes);
    }

    return await withSpan(operation, run, { type: spanType, attributes: attrs });
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    const error = err instanceof Error ? err : new Error(String(err));
    if (client && initConfig) {
      const kindInner = options?.kind ?? 'internal';
      const perf = kindInner === 'db' ? {} : { performance: { operation, duration_ms, failed: true, kind: kindInner } };
      const dbCtx =
        kindInner === 'db'
          ? {
              db: {
                system: options?.dbSystem ?? 'unknown',
                operation: options?.dbSqlVerb ?? extractSqlVerb(options?.dbSql) ?? operation,
                ...(options?.dbTable !== undefined ? { table: options.dbTable } : {}),
                duration_ms,
              },
            }
          : {};
      client.enqueue(
        buildErrorEvent({
          service: initConfig.service,
          environment: initConfig.environment,
          error,
          context: {
            ...dbCtx,
            ...perf,
          },
        }),
      );
    }
    throw err;
  }
}

/**
 * Database work: records a **db** span (duration + system / operation / table when provided).
 * On failure, emits an error event (same as legacy `measure` + `db` kind).
 */
export async function runQuery<T>(
  dbSystem: string,
  operationName: string,
  fn: () => Promise<T> | T,
  options?: RunQueryOptions,
): Promise<T> {
  const { client, initConfig } = getSdkRuntime();
  const sqlVerb = options?.sqlVerb ?? extractSqlVerb(options?.sql);
  const dbOperation = sqlVerb ?? operationName;
  const start = performance.now();
  const attributes = {
    db_system: dbSystem,
    db_operation: dbOperation,
    ...(options?.table !== undefined ? { db_table: options.table } : {}),
    ...options?.attributes,
  };
  // `undefined` = nested mode (withSpan owns the span); `null` = leaf mode without an active trace.
  const leafSpan = options?.leaf === true ? beginOutboundSpan() : undefined;
  try {
    if (options?.leaf === true) {
      const result = await Promise.resolve(fn());
      if (leafSpan !== null && leafSpan !== undefined) {
        endOutboundSpan(leafSpan, { name: operationName, type: 'db', attributes });
      }
      return result;
    }
    return await withSpan(operationName, () => Promise.resolve(fn()), {
      type: 'db',
      attributes,
    });
  } catch (err) {
    const duration_ms = Math.round(performance.now() - start);
    const error = err instanceof Error ? err : new Error(String(err));
    if (leafSpan !== null && leafSpan !== undefined) {
      endOutboundSpan(leafSpan, { name: operationName, type: 'db', attributes, err: error });
    }
    if (client && initConfig && options?.captureError !== false) {
      client.enqueue(
        buildErrorEvent({
          service: initConfig.service,
          environment: initConfig.environment,
          error,
          context: {
            db: {
              system: dbSystem,
              operation: dbOperation,
              ...(options?.table !== undefined ? { table: options.table } : {}),
              duration_ms,
            },
          },
        }),
      );
    }
    throw err;
  }
}
