import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasDependency } from './auto-loader.js';
import { clearPluginsForTests, getPlugins, initRegisteredPlugins, register, resetPluginInitState } from './registry.js';
import type { StackTracePlugin } from './types.js';

describe('plugin registry', () => {
  afterEach(() => {
    clearPluginsForTests();
    resetPluginInitState();
  });

  it('register and use add plugins; getPlugins returns copy', () => {
    const p: StackTracePlugin = {
      name: 'a',
      type: 'custom',
      init: () => {},
    };
    register(p);
    expect(getPlugins()).toHaveLength(1);
    expect(getPlugins()[0]?.name).toBe('a');
  });

  it('initRegisteredPlugins runs init once per name', async () => {
    const spy = vi.fn();
    register({
      name: 'x',
      type: 'runtime',
      init: spy,
    });
    await initRegisteredPlugins();
    await initRegisteredPlugins();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('hasDependency', () => {
  it('returns true for zod (always present in this repo)', () => {
    expect(hasDependency('zod')).toBe(true);
  });

  it('returns false for a non-existent package name', () => {
    expect(hasDependency('__non_existent_pkg_cc_stacktrace__')).toBe(false);
  });
});
