import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSdkDisabledByEnv, KILL_SWITCH_ENV, refreshKillSwitch } from './kill-switch.js';

describe('kill switch (STACKTRACE_DISABLED)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    refreshKillSwitch();
  });

  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('%j desliga o SDK', (value) => {
    vi.stubEnv(KILL_SWITCH_ENV, value);
    refreshKillSwitch();
    expect(isSdkDisabledByEnv()).toBe(true);
  });

  it.each(['', '0', 'false', 'no', 'off', 'disabled'])('%j mantém o SDK ligado', (value) => {
    vi.stubEnv(KILL_SWITCH_ENV, value);
    refreshKillSwitch();
    expect(isSdkDisabledByEnv()).toBe(false);
  });

  it('variável ausente mantém o SDK ligado', () => {
    const saved = process.env[KILL_SWITCH_ENV];
    delete process.env[KILL_SWITCH_ENV];
    try {
      refreshKillSwitch();
      expect(isSdkDisabledByEnv()).toBe(false);
    } finally {
      if (saved !== undefined) process.env[KILL_SWITCH_ENV] = saved;
    }
  });

  it('guarda o valor lido até refreshKillSwitch()', () => {
    vi.stubEnv(KILL_SWITCH_ENV, '1');
    refreshKillSwitch();
    expect(isSdkDisabledByEnv()).toBe(true);
    vi.stubEnv(KILL_SWITCH_ENV, '0');
    expect(isSdkDisabledByEnv()).toBe(true);
    refreshKillSwitch();
    expect(isSdkDisabledByEnv()).toBe(false);
  });
});
