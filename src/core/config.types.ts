import type { StackTraceEvent } from './stacktrace-event.types.js';
import type { OutboundHttpOptions } from '../integrations/outbound-http/types.js';

export type SendMode = 'batch' | 'immediate';

/** `StackTrace.auto({ outboundHttp })` config: opt-in flags (D2) plus the shared {@link OutboundHttpOptions}. */
export type OutboundHttpAutoOptions = OutboundHttpOptions & {
  instrumentFetch?: boolean;
  instrumentNodeHttp?: boolean;
};

export type SdkLogger = {
  debug?: (fields: Record<string, unknown>, message: string) => void;
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
};

export type StackTraceInitOptions = {
  apiKey: string;
  /** Stable services.id UUID copied from the dashboard /services screen. */
  serviceId: string;
  /** Optional display label. Not used as service identity. */
  service?: string;
  /** Optional display/deploy label. Not used as service identity. */
  environment?: string;
  /** Base URL for the ingestion API (path may be appended by the transport). */
  endpoint: string;
  sendMode?: SendMode;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  getHeaders?: () => Record<string, string>;
  beforeSend?: (event: StackTraceEvent) => StackTraceEvent | null;
  transport?: (payload: unknown) => Promise<void>;
  enableGlobalHandlers?: boolean;
  onTransportError?: (err: unknown) => void;
  /** Optional structured logger used for SDK configuration and transport diagnostics. */
  logger?: SdkLogger;
  enabled?: boolean;
  debug?: boolean;
  headerRedaction?: {
    extraSensitiveKeys?: readonly string[];
  };
  urlRedaction?: {
    extraSensitiveQueryKeys?: readonly string[];
  };
  /** App release (e.g. git SHA or semver) — merged into every event `context`. */
  release?: string;
  /**
   * When set to a positive number (ms), polls `GET /ingest/capture-policy` and filters events by
   * remote policy. Omit or `0` to disable (no extra HTTP; all event types allowed locally).
   */
  capturePolicyRefreshMs?: number;
  /** Full URL for capture-policy GET; default `${endpoint}/ingest/capture-policy?serviceId`. */
  capturePolicyUrl?: string;
  /**
   * Optional legacy scope override. Modern ingestion resolves tenant/project from the API key
   * and does not require clients to configure these values.
   */
  tenantId?: string;
  projectId?: string;
};

/**
 * Options for {@link StackTrace.auto}: same as {@link StackTraceInitOptions} plus optional framework clients
 * (registered after `init`, without coupling the core package to those types at import time).
 */
export type StackTraceAutoOptions = StackTraceInitOptions & {
  /** When set, registers `cc-stacktracer/fastify` on this instance. */
  fastify?: import('fastify').FastifyInstance;
  /**
   * Prisma Client — registers `cc-stacktracer/db-prisma` when installed.
   * On **Prisma 6+**, `prisma.$use` was removed: omit this and apply
   * `createStackTracePrismaQueryExtension()` via `new PrismaClient().$extends(...)` instead.
   */
  prisma?: unknown;
  /** Lucid / Adonis Database — enables `cc-stacktracer/db-lucid` hooks when the package is installed. */
  lucid?: unknown;
  /** Outbound HTTP instrumentation (opt-in). e.g. `{ instrumentFetch: true, internalServiceMap: {...} }`. */
  outboundHttp?: OutboundHttpAutoOptions;
};
