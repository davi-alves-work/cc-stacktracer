export const KILL_SWITCH_ENV = 'STACKTRACE_DISABLED';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

let cached: boolean | undefined;

/** Lido uma vez e guardado: `process.env` é lento o bastante para pesar no hot path. */
export function isSdkDisabledByEnv(): boolean {
  if (cached === undefined) {
    cached = TRUTHY.has((process.env[KILL_SWITCH_ENV] ?? '').trim().toLowerCase());
  }
  return cached;
}

export function refreshKillSwitch(): void {
  cached = undefined;
}
