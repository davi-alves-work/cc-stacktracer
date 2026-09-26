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
  /**
   * Chave de idempotência (UUID), atribuída UMA vez quando o evento entra na fila. Vai para o `event_id`
   * do fio e se repete em todo retry — antes era sorteada na normalização, a cada tentativa, e um reenvio
   * de algo já aceito virava um segundo evento que nenhum dedupe por `event_id` enxergava.
   */
  eventId?: string;
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
