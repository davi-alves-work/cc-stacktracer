import { mergeEventContext } from '../core/request-context.js';
import { SCHEMA_VERSION, type ErrorEvent, type ServiceDescriptor } from '../core/stacktrace-event.types.js';
import { sanitizeStackTrace } from '../utils/sanitize-stack.js';
import { nowIso } from '../utils/time.js';

export type BuildErrorEventParams = {
  service: ServiceDescriptor;
  environment: string;
  error: Error;
  context?: Record<string, unknown>;
};

export function buildErrorEvent(params: BuildErrorEventParams): ErrorEvent {
  const context = mergeEventContext(params.context);
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    service: params.service,
    environment: params.environment,
    timestamp: nowIso(),
    message: params.error.message,
    ...(params.error.stack !== undefined ? { stack: sanitizeStackTrace(params.error.stack) } : {}),
    ...(params.error.name !== undefined ? { name: params.error.name } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}
