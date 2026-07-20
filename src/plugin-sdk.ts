/**
 * Stable surface for `@cc-stacktracer/*` integration packages. Avoid importing deep `src/` paths from plugins.
 */

import { getSdkRuntime } from './core/client-ref.js';
import type { StackTraceClient } from './core/stacktrace-client.js';

export { getSdkRuntime } from './core/client-ref.js';
export type { SdkInitConfig } from './core/client-ref.js';

/** Same as `getStackTraceClient` on the main entry — avoids circular imports via `index.js`. */
export function getStackTraceClient(): StackTraceClient | null {
  return getSdkRuntime().client;
}
export type { StackTraceClient } from './core/stacktrace-client.js';
export { getRequestSnapshot, runWithRequestContext, type HttpRequestSnapshot } from './core/request-context.js';
export {
  runWithTraceContext,
  getTraceIdFromContext,
  rootSpanIdFromContext,
  getTraceSpanState,
  currentParentSpanIdForChild,
  pushActiveSpan,
  popActiveSpan,
  type TraceSpanAlsState,
} from './core/trace-span-context.js';
export { extractCorrelationFromHeaders, type CorrelationFields } from './utils/correlation.js';
export { buildHttpIntegrationContext } from './utils/http-integration-context.js';
export { redactHeaders } from './utils/redact-headers.js';
export type { StackTracePlugin, StackTraceContext, PluginType } from './core/plugins/types.js';
export { isStackTracePlugin } from './core/plugins/types.js';
