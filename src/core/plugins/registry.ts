import { getSdkRuntime } from '../client-ref.js';
import type { StackTraceClient } from '../stacktrace-client.js';
import type { SdkInitConfig } from '../client-ref.js';
import { isStackTracePlugin, type StackTraceContext, type StackTracePlugin } from './types.js';

const plugins: StackTracePlugin[] = [];
const inited = new Set<string>();

function buildContext(): StackTraceContext {
  return {
    getClient(): StackTraceClient | null {
      return getSdkRuntime().client;
    },
    getInitConfig(): SdkInitConfig | null {
      return getSdkRuntime().initConfig;
    },
  };
}

/**
 * Register a plugin (idempotent by `name` — second register replaces the previous with the same name).
 */
export function register(plugin: StackTracePlugin): void {
  if (!isStackTracePlugin(plugin)) {
    throw new TypeError('StackTrace.register: invalid plugin shape');
  }
  const idx = plugins.findIndex((p) => p.name === plugin.name);
  if (idx >= 0) {
    plugins[idx] = plugin;
  } else {
    plugins.push(plugin);
  }
  inited.delete(plugin.name);
}

/** Alias for {@link register} (Express-style). */
export function use(plugin: StackTracePlugin): void {
  register(plugin);
}

export function getPlugins(): readonly StackTracePlugin[] {
  return [...plugins];
}

export function clearPluginsForTests(): void {
  plugins.length = 0;
  inited.clear();
}

const PLUGIN_ORDER: Record<string, number> = {
  http: 0,
  runtime: 1,
  db: 2,
  custom: 3,
};

function sortPlugins(list: StackTracePlugin[]): StackTracePlugin[] {
  return [...list].sort((a, b) => {
    const da = PLUGIN_ORDER[a.type] ?? 99;
    const db = PLUGIN_ORDER[b.type] ?? 99;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Runs `init` once per plugin name (after {@link register}).
 */
export async function initRegisteredPlugins(): Promise<void> {
  const ctx = buildContext();
  const ordered = sortPlugins(plugins);
  for (const p of ordered) {
    if (inited.has(p.name)) continue;
    await Promise.resolve(p.init(ctx));
    inited.add(p.name);
  }
}

/** Mark a plugin as needing init again (e.g. after tests). */
export function resetPluginInitState(): void {
  inited.clear();
}
