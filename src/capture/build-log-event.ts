import { mergeEventContext } from '../core/request-context.js';
import { SCHEMA_VERSION, type LogEvent, type ServiceDescriptor } from '../core/stacktrace-event.types.js';
import { nowIso } from '../utils/time.js';

export type BuildLogEventParams = {
  service: ServiceDescriptor;
  environment: string;
  message: string;
  level?: LogEvent['level'];
  context?: Record<string, unknown>;
};

export function buildLogEvent(params: BuildLogEventParams): LogEvent {
  const context = mergeEventContext(params.context);
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'log',
    service: params.service,
    environment: params.environment,
    timestamp: nowIso(),
    message: params.message,
    level: params.level ?? 'info',
    ...(context !== undefined ? { context } : {}),
  };
}
