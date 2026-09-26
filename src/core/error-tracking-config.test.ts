import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from './client-ref.js';
import { getErrorTrackingConfig, resolveErrorTrackingConfig } from './error-tracking-config.js';

describe('resolveErrorTrackingConfig', () => {
  it('padrao: ligado; servidor e cliente em 500-599', () => {
    const c = resolveErrorTrackingConfig({ env: {}, warn: vi.fn() });
    expect(c.enabled).toBe(true);
    expect([c.isServerErrorStatus(500), c.isServerErrorStatus(404)]).toEqual([true, false]);
    expect([c.isClientErrorStatus(503), c.isClientErrorStatus(404)]).toEqual([true, false]);
  });

  it('STACKTRACE_ERROR_TRACKING_ENABLED=false desliga; a opcao vence a env', () => {
    expect(
      resolveErrorTrackingConfig({ env: { STACKTRACE_ERROR_TRACKING_ENABLED: 'false' }, warn: vi.fn() }).enabled,
    ).toBe(false);
    expect(
      resolveErrorTrackingConfig({
        errorTracking: true,
        env: { STACKTRACE_ERROR_TRACKING_ENABLED: '0' },
        warn: vi.fn(),
      }).enabled,
    ).toBe(true);
  });

  it('faixas pela env', () => {
    const c = resolveErrorTrackingConfig({
      env: { STACKTRACE_HTTP_SERVER_ERROR_STATUSES: '500-599,429', STACKTRACE_HTTP_CLIENT_ERROR_STATUSES: '400-599' },
      warn: vi.fn(),
    });
    expect(c.isServerErrorStatus(429)).toBe(true);
    expect(c.isClientErrorStatus(404)).toBe(true);
  });
});

describe('getErrorTrackingConfig', () => {
  afterEach(() => setSdkRuntime(null, null));

  it('sem init devolve o padrao', () => {
    expect(getErrorTrackingConfig().enabled).toBe(true);
    expect(getErrorTrackingConfig().isServerErrorStatus(500)).toBe(true);
  });
});
