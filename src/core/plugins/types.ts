import type { StackTraceClient } from '../stacktrace-client.js';
import type { SdkInitConfig } from '../client-ref.js';

/**
 * Plugin category for grouping and optional ordering (e.g. HTTP before DB for trace roots).
 */
export type PluginType = 'http' | 'db' | 'runtime' | 'custom';

/**
 * Context passed to {@link StackTracePlugin.init} — stable surface for integrations without importing deep SDK paths.
 */
export type StackTraceContext = {
  getClient(): StackTraceClient | null;
  getInitConfig(): SdkInitConfig | null;
};

/**
 * Pluggable integration (Fastify, Prisma, etc.). Keep `init` idempotent where possible.
 */
export type StackTracePlugin = {
  name: string;
  type: PluginType;
  init(ctx: StackTraceContext): void | Promise<void>;
};

export function isStackTracePlugin(value: unknown): value is StackTracePlugin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    (v.type === 'http' || v.type === 'db' || v.type === 'runtime' || v.type === 'custom') &&
    typeof v.init === 'function'
  );
}
