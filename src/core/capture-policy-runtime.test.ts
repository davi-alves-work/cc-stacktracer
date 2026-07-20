import { describe, expect, it, vi, afterEach } from 'vitest';
import { CapturePolicyRuntime } from './capture-policy-runtime.js';

describe('CapturePolicyRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('start fetches and updates policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            capturePolicy: {
              captureErrors: false,
              captureLogs: true,
              captureHttpRequests: true,
            },
          },
        }),
      }),
    );

    const rt = new CapturePolicyRuntime({
      apiKey: 'k',
      endpoint: 'http://localhost:3000',
      serviceId: '11111111-1111-4111-8111-111111111111',
      service: 'api',
      environment: 'prod',
      refreshMs: 0,
    });
    rt.start();

    await vi.waitFor(() => {
      expect(rt.get().defaults.error).toBe(false);
    });

    rt.stop();
  });
});
