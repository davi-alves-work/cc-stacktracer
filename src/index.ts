import { buildErrorEvent } from './capture/build-error-event.js';
import { buildLogEvent } from './capture/build-log-event.js';
import { setSdkRuntime, getSdkRuntime } from './core/client-ref.js';
import { parseStackTraceInit } from './core/config.schema.js';
import type { StackTraceAutoOptions, StackTraceInitOptions } from './core/config.types.js';
import type { StackTracePlugin } from './core/plugins/types.js';
import {
  getPlugins,
  initRegisteredPlugins,
  register as registerPlugin,
  use as usePlugin,
} from './core/plugins/registry.js';
import { hasDependency, loadAutoPlugins } from './core/plugins/auto-loader.js';
import { registerGlobalHandlers } from './core/global-handlers.js';
import { clearTags, clearUser, resetScopeMetadata, setTags, setUser, tag } from './core/scope-metadata.js';
import { withBusinessContext, withBusinessContextAsync } from './core/business-context.js';
import { createStackTraceClient, StackTraceClient, type BatchTransportPayload } from './core/stacktrace-client.js';
import type { ServiceDescriptor, StackTraceEvent } from './core/stacktrace-event.types.js';
import { endSpan, startSpan, withSpan } from './core/tracing.js';
import { instrumentFetch, instrumentNodeHttp } from './integrations/outbound-http/index.js';
import { endHttpRequest, runWithHttpContext, startHttpRequest } from './generic-http/index.js';
import { measure, runQuery } from './performance/measure.js';

/**
 * Returns the current singleton client for use by integrations (e.g. Fastify plugin).
 * Null if `init` has not been called.
 */
export function getStackTraceClient(): StackTraceClient | null {
  return getSdkRuntime().client;
}

/**
 * Initialize the SDK. Call once at startup. Re-initializing replaces the previous client.
 */
export function init(options: StackTraceInitOptions): void {
  const parsed = parseStackTraceInit(options);
  const previous = getSdkRuntime().client;
  if (previous !== null) {
    previous.detachScheduling();
  }
  const nextClient = new StackTraceClient(parsed);
  const service: ServiceDescriptor = {
    name: parsed.service,
    version: parsed.release ?? process.env.APP_VERSION ?? 'unknown',
    environment: parsed.environment,
  };
  setSdkRuntime(nextClient, {
    service,
    environment: parsed.environment,
    endpoint: parsed.endpoint,
    ...(parsed.tenantId !== undefined ? { tenantId: parsed.tenantId } : {}),
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
  });
  if (parsed.enableGlobalHandlers) {
    registerGlobalHandlers({
      captureException: (err) => {
        const { client, initConfig } = getSdkRuntime();
        if (client && initConfig) {
          client.enqueue(
            buildErrorEvent({
              service: initConfig.service,
              environment: initConfig.environment,
              error: err,
            }),
          );
        }
      },
      flush: () => {
        const { client } = getSdkRuntime();
        return client ? client.flush() : Promise.resolve();
      },
    });
  }
}

export function captureException(error: Error, context?: Record<string, unknown>): void {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) return;
  client.enqueue(
    buildErrorEvent({
      service: initConfig.service,
      environment: initConfig.environment,
      error,
      ...(context !== undefined ? { context } : {}),
    }),
  );
}

export function log(message: string, metadata?: Record<string, unknown>): void {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) return;
  client.enqueue(
    buildLogEvent({
      service: initConfig.service,
      environment: initConfig.environment,
      message,
      ...(metadata !== undefined ? { context: metadata } : {}),
    }),
  );
}

export type StructuredLogInput = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  attributes?: Record<string, unknown>;
  /** High-level operation name (e.g. `db.query`, `internal.job`). */
  operation?: string;
  /** Duration in milliseconds for performance-oriented structured logs. */
  duration_ms?: number;
};

export function logStructured(params: StructuredLogInput): void {
  const { client, initConfig } = getSdkRuntime();
  if (!client || !initConfig) return;
  const perfFields: Record<string, unknown> = {};
  if (params.operation !== undefined) perfFields.operation = params.operation;
  if (params.duration_ms !== undefined) perfFields.duration_ms = params.duration_ms;
  const hasPerf = Object.keys(perfFields).length > 0;
  let contextAttrs: Record<string, unknown> | undefined;
  if (params.attributes !== undefined) {
    contextAttrs = { ...params.attributes };
    if (hasPerf) {
      const prev = contextAttrs.performance;
      const prevObj =
        typeof prev === 'object' && prev !== null && !Array.isArray(prev)
          ? { ...(prev as Record<string, unknown>) }
          : {};
      contextAttrs.performance = { ...prevObj, ...perfFields };
    }
  } else if (hasPerf) {
    contextAttrs = { performance: perfFields };
  }
  client.enqueue(
    buildLogEvent({
      service: initConfig.service,
      environment: initConfig.environment,
      message: params.message,
      level: params.level,
      ...(contextAttrs !== undefined ? { context: contextAttrs } : {}),
    }),
  );
}

export async function flush(): Promise<void> {
  const { client } = getSdkRuntime();
  if (client) await client.flush();
}

export async function shutdown(): Promise<void> {
  const { client } = getSdkRuntime();
  if (client) {
    await client.shutdown();
    setSdkRuntime(null, null);
  }
  resetScopeMetadata();
}

/**
 * Initialize the SDK and optionally wire framework integrations (Fastify, Prisma, Lucid) when the matching packages are installed.
 */
export async function auto(options: StackTraceAutoOptions): Promise<void> {
  const { fastify, prisma, lucid, outboundHttp, ...initOpts } = options;
  init(initOpts);
  // D2: outbound instrumentation is opt-in — only wired when explicitly requested.
  if (outboundHttp?.instrumentFetch === true) {
    instrumentFetch(outboundHttp);
  }
  if (outboundHttp?.instrumentNodeHttp === true) {
    instrumentNodeHttp(outboundHttp);
  }
  try {
    await loadAutoPlugins();
  } catch {
    /* optional workspace packages */
  }
  if (prisma !== undefined && hasDependency('@prisma/client')) {
    try {
      const mod = (await import('./db/prisma.js')) as {
        createPrismaStackTracePlugin?: (p: unknown) => StackTracePlugin;
      };
      if (typeof mod.createPrismaStackTracePlugin === 'function') {
        registerPlugin(mod.createPrismaStackTracePlugin(prisma));
      }
    } catch {
      /* optional */
    }
  }
  if (lucid !== undefined && hasDependency('@adonisjs/lucid')) {
    try {
      const mod = (await import('./db/lucid.js')) as {
        createLucidStackTracePlugin?: (db: unknown) => StackTracePlugin;
      };
      if (typeof mod.createLucidStackTracePlugin === 'function') {
        registerPlugin(mod.createLucidStackTracePlugin(lucid));
      }
    } catch {
      /* optional */
    }
  }
  await initRegisteredPlugins();
  if (fastify !== undefined && hasDependency('fastify')) {
    try {
      const { default: fastifyPlugin } = await import('./integrations/fastify.js');
      await fastify.register(fastifyPlugin);
    } catch (e) {
      console.warn('[cc-stacktracer] Fastify plugin failed to register:', e);
    }
  }
}

export const StackTrace = {
  init,
  auto,
  register: registerPlugin,
  use: usePlugin,
  getPlugins,
  loadAutoPlugins,
  hasDependency,
  captureException,
  log,
  logStructured,
  measure,
  withSpan,
  startSpan,
  endSpan,
  instrumentFetch,
  instrumentNodeHttp,
  runQuery,
  startHttpRequest,
  runWithHttpContext,
  endHttpRequest,
  withBusinessContext,
  withBusinessContextAsync,
  setUser,
  clearUser,
  tag,
  setTags,
  clearTags,
  flush,
  shutdown,
};

export { createStackTraceClient, StackTraceClient };
export type { BatchTransportPayload };
export { IngestTransportError } from './core/transport/ingest-transport-error.js';
export { registerPlugin as register, usePlugin as use, getPlugins, loadAutoPlugins, hasDependency };
export type { StackTraceInitOptions, StackTraceAutoOptions, StackTraceEvent, ServiceDescriptor };
export type { StackTracePlugin, PluginType } from './core/plugins/types.js';
export type { BusinessContext } from './core/business-context.js';
export { mergeEventContext, mergeRequestIntoContext } from './core/request-context.js';
export { clearTags, clearUser, setTags, setUser, tag } from './core/scope-metadata.js';
export { withBusinessContext, withBusinessContextAsync } from './core/business-context.js';

export { extractCorrelationFromHeaders, hasCorrelationData, type CorrelationFields } from './utils/correlation.js';
export { parseTraceparent, type ParsedTraceparent } from './utils/traceparent.js';
export type { CapturePolicy, CaptureEventType } from './schemas/capture-policy.schema.js';
export {
  DEFAULT_CAPTURE_POLICY,
  parseCapturePolicyJson,
  compileCapturePolicy,
} from './schemas/capture-policy.schema.js';
export type { CaptureContext } from './observability/capture/types.js';
export { CaptureGate, CapturePolicyCache, RuleEngine } from './observability/capture/index.js';
export { extractSqlVerb, measure, runQuery } from './performance/measure.js';
export type { MeasureOptions, RunQueryOptions } from './performance/measure.js';
export { withSpan, startSpan, endSpan, beginOutboundSpan, endOutboundSpan } from './core/tracing.js';
export type { SpanHandle, SpanOptions, OutboundSpanStart } from './core/tracing.js';
export { instrumentFetch, instrumentNodeHttp } from './integrations/outbound-http/index.js';
export type { OutboundHttpOptions, OutboundClassification } from './integrations/outbound-http/index.js';
export { httpSpanName, dbSpanName, serviceSpanName, externalSpanName } from './core/span-names.js';
export {
  StackTraceHttpRequest,
  endHttpRequest,
  runWithHttpContext,
  startHttpRequest,
  type StackTraceHttpRequestInput,
  type StackTraceHttpRequestSnapshot,
  type StackTraceHttpResponseInput,
} from './generic-http/index.js';

/** Canonical event model (v4) — shared with ingestion and worker. */
export type { EventV4, CanonicalInput, NormalizeOptions } from './shared/schema/index.js';
export { EventSchemaV4, normalizeEventV4, normalizeHttpRouteForSpan } from './shared/schema/index.js';
