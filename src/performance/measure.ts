import { annotateError, captureErrorOnce, isErrorTracked } from '../core/error-tracking.js';
import { isTelemetryActive, safeRun } from '../core/safe-run.js';
import { beginOutboundSpan, endOutboundSpan, withSpan, type SpanOptions } from '../core/tracing.js';
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
  /**
   * When false, `runQuery` sends no error event of its own. Inside a trace the event belongs to Error Tracking
   * anyway (one per request/job), so this only matters outside a trace or with `errorTracking: false`.
   * Default true.
   */
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
  // Medir uma chamada HTTP e medir uma chamada de SAIDA: `external`, nunca o `http` da requisicao recebida.
  if (kind === 'http') return 'external';
  if (kind === 'queue') return 'external';
  return 'business';
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function measureSpanOptions(operation: string, options: MeasureOptions | undefined): SpanOptions {
  const kind = options?.kind ?? 'internal';
  const attributes: Record<string, unknown> = {};
  if (kind === 'db') {
    const sqlVerb = options?.dbSqlVerb ?? extractSqlVerb(options?.dbSql);
    attributes.db_system = options?.dbSystem ?? 'unknown';
    attributes.db_operation = sqlVerb ?? operation;
    if (options?.dbTable !== undefined) attributes.db_table = options.dbTable;
  }
  if (kind === 'http') {
    attributes.http_route = operation;
  }
  if (kind === 'queue') {
    attributes.metadata_hint = operation;
  }
  if (options?.attributes !== undefined) {
    Object.assign(attributes, options.attributes);
  }
  return { type: kindToSpanType(kind), attributes };
}

function measureErrorContext(
  operation: string,
  options: MeasureOptions | undefined,
  start: number,
): Record<string, unknown> {
  const duration_ms = Math.round(performance.now() - start);
  const kind = options?.kind ?? 'internal';
  if (kind !== 'db') return { performance: { operation, duration_ms, failed: true, kind } };
  return {
    db: {
      system: options?.dbSystem ?? 'unknown',
      operation: options?.dbSqlVerb ?? extractSqlVerb(options?.dbSql) ?? operation,
      ...(options?.dbTable !== undefined ? { table: options.dbTable } : {}),
      duration_ms,
    },
  };
}

/**
 * O erro leva o contexto da operacao ANTES de o span fechar: numa raiz ja fechada o Error Tracking envia
 * na hora, e o bloco `db`/`performance` precisa ja estar la.
 */
function annotateThrown(err: unknown, context: () => Record<string, unknown>): void {
  if (err instanceof Error) safeRun('annotateError', () => annotateError(err, context()));
}

function annotated<T>(fn: () => Promise<T> | T, context: () => Record<string, unknown>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      annotateThrown(err, context);
      throw err;
    }
  };
}

/**
 * Dentro de um trace o erro e do Error Tracking — um evento por requisicao/job, o do span mais alto. Evento
 * proprio so sem trace ou com o Error Tracking desligado, como na 2.x.
 */
function captureUntrackedError(err: unknown, context: Record<string, unknown>): void {
  const error = asError(err);
  if (isErrorTracked(error)) return;
  captureErrorOnce(error, context);
}

/**
 * Runs `fn`, records duration as a **span** (no success log). On failure, the error reaches `/errors` once —
 * through Error Tracking inside a trace, directly otherwise — carrying a `performance` (or `db`) block, and
 * is rethrown.
 */
export async function measure<T>(operation: string, fn: () => Promise<T> | T, options?: MeasureOptions): Promise<T> {
  const start = performance.now();
  const spanOptions =
    options?.silent === true || !isTelemetryActive()
      ? undefined
      : safeRun('measure.setup', () => measureSpanOptions(operation, options));
  const errorContext = (): Record<string, unknown> => measureErrorContext(operation, options, start);
  let out: Awaited<T>;
  try {
    out = spanOptions === undefined ? await fn() : await withSpan(operation, annotated(fn, errorContext), spanOptions);
  } catch (err) {
    safeRun('measure.captureError', () => captureUntrackedError(err, errorContext()));
    throw err;
  }
  return out;
}

type QueryTelemetry = { dbOperation: string; attributes: Record<string, unknown> };

function queryTelemetry(dbSystem: string, operationName: string, options: RunQueryOptions | undefined): QueryTelemetry {
  const dbOperation = options?.sqlVerb ?? extractSqlVerb(options?.sql) ?? operationName;
  return {
    dbOperation,
    attributes: {
      db_system: dbSystem,
      db_operation: dbOperation,
      ...(options?.table !== undefined ? { db_table: options.table } : {}),
      ...options?.attributes,
    },
  };
}

function queryErrorContext(
  dbSystem: string,
  query: QueryTelemetry,
  options: RunQueryOptions | undefined,
  start: number,
): Record<string, unknown> {
  return {
    db: {
      system: dbSystem,
      operation: query.dbOperation,
      ...(options?.table !== undefined ? { table: options.table } : {}),
      duration_ms: Math.round(performance.now() - start),
    },
  };
}

function captureQueryError(err: unknown, options: RunQueryOptions | undefined, context: Record<string, unknown>): void {
  if (options?.captureError === false) return;
  captureUntrackedError(err, context);
}

/**
 * Database work: records a **db** span (duration + system / operation / table when provided).
 * On failure, the error reaches `/errors` once — through Error Tracking inside a trace, directly otherwise —
 * carrying a `db` block, and is rethrown.
 *
 * O `try` envolve SÓ a query: se o span fosse emitido dentro dele e lançasse depois do commit, o
 * `catch` relançaria o erro do SDK e a app faria retry de um INSERT que já aconteceu.
 */
export async function runQuery<T>(
  dbSystem: string,
  operationName: string,
  fn: () => Promise<T> | T,
  options?: RunQueryOptions,
): Promise<T> {
  const start = performance.now();
  const query = isTelemetryActive()
    ? safeRun('runQuery.setup', () => queryTelemetry(dbSystem, operationName, options))
    : undefined;
  if (query === undefined) {
    return fn();
  }
  const errorContext = (): Record<string, unknown> => queryErrorContext(dbSystem, query, options, start);
  if (options?.leaf !== true) {
    let nested: Awaited<T>;
    try {
      nested = await withSpan(operationName, annotated(fn, errorContext), { type: 'db', attributes: query.attributes });
    } catch (err) {
      safeRun('runQuery.captureError', () => captureQueryError(err, options, errorContext()));
      throw err;
    }
    return nested;
  }
  const leafSpan = beginOutboundSpan();
  let out: Awaited<T>;
  try {
    out = await fn();
  } catch (err) {
    annotateThrown(err, errorContext);
    safeRun('runQuery.end', () => {
      if (leafSpan !== null) {
        endOutboundSpan(leafSpan, { name: operationName, type: 'db', attributes: query.attributes, err: asError(err) });
      }
    });
    safeRun('runQuery.captureError', () => captureQueryError(err, options, errorContext()));
    throw err;
  }
  if (leafSpan !== null) {
    endOutboundSpan(leafSpan, { name: operationName, type: 'db', attributes: query.attributes });
  }
  return out;
}
