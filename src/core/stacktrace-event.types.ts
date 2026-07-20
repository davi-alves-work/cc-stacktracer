export const SCHEMA_VERSION = 1 as const;

export type EventType = 'error' | 'log';

/** Structured service identity (aligned with canonical ingestion `service` block). */
export type ServiceDescriptor = {
  name: string;
  version: string;
  environment: string;
};

export type BaseEnvelope = {
  schemaVersion: typeof SCHEMA_VERSION;
  type: EventType;
  service: ServiceDescriptor;
  /** Duplicates `service.environment` for backward compatibility with string-only legacy envelopes. */
  environment: string;
  timestamp: string;
  context?: Record<string, unknown>;
};

export type ErrorEvent = BaseEnvelope & {
  type: 'error';
  message: string;
  stack?: string;
  name?: string;
};

export type LogEvent = BaseEnvelope & {
  type: 'log';
  message: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
};

export type StackTraceEvent = ErrorEvent | LogEvent;
