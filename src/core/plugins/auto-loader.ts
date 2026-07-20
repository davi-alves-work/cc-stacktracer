import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isStackTracePlugin, type StackTracePlugin } from './types.js';
import { register } from './registry.js';

export type AutoPluginResolution = {
  /** npm package name to resolve (e.g. `fastify`). */
  dependency: string;
  /** cc-stacktracer subpath to dynamically import (must export `stackTracePlugin`). */
  moduleId: string;
};

/** HTTP plugins: register noop `stackTracePlugin` entries for discovery; wire Fastify via `StackTrace.auto({ fastify })` or `app.register(default)`. */
export const DEFAULT_AUTO_PLUGIN_RESOLUTIONS: readonly AutoPluginResolution[] = [
  { dependency: 'fastify', moduleId: 'cc-stacktracer/fastify' },
  { dependency: '@adonisjs/core', moduleId: 'cc-stacktracer/adonis' },
];

let requireFromRoot: ReturnType<typeof createRequire> | null = null;

function getRequire(): ReturnType<typeof createRequire> {
  if (requireFromRoot === null) {
    requireFromRoot = createRequire(pathToFileURL(process.cwd() + '/package.json').href);
  }
  return requireFromRoot;
}

/**
 * Returns whether `dependency` appears installable from the current working directory (monorepo / app root).
 */
export function hasDependency(dependency: string): boolean {
  try {
    getRequire().resolve(`${dependency}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export type ImportPluginModuleResult =
  | { ok: true; plugin: StackTracePlugin }
  | { ok: false; reason: 'not_found' | 'invalid_export' | 'import_failed'; detail?: string };

/**
 * Dynamically imports `moduleId` and reads `stackTracePlugin` (preferred) or a valid default export.
 */
export async function importPluginModule(moduleId: string): Promise<ImportPluginModuleResult> {
  try {
    const mod = (await import(moduleId)) as Record<string, unknown>;
    const candidate = mod.stackTracePlugin ?? mod.default;
    if (isStackTracePlugin(candidate)) {
      return { ok: true, plugin: candidate };
    }
    return { ok: false, reason: 'invalid_export', detail: moduleId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      return { ok: false, reason: 'not_found', detail: msg };
    }
    return { ok: false, reason: 'import_failed', detail: msg };
  }
}

export type LoadAutoPluginsOptions = {
  resolutions?: readonly AutoPluginResolution[];
  /** If true, register every successfully loaded plugin. Default true. */
  registerPlugins?: boolean;
};

/**
 * For each resolution where `hasDependency` is true, import the plugin module and optionally {@link register} it.
 */
export async function loadAutoPlugins(opts?: LoadAutoPluginsOptions): Promise<StackTracePlugin[]> {
  const resolutions = opts?.resolutions ?? DEFAULT_AUTO_PLUGIN_RESOLUTIONS;
  const doRegister = opts?.registerPlugins !== false;
  const loaded: StackTracePlugin[] = [];
  for (const { dependency, moduleId } of resolutions) {
    if (!hasDependency(dependency)) continue;
    const result = await importPluginModule(moduleId);
    if (!result.ok) continue;
    if (doRegister) {
      register(result.plugin);
    }
    loaded.push(result.plugin);
  }
  return loaded;
}
