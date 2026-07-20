import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapturePolicyCache } from './CapturePolicyCache.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function cache(fetchErrors: unknown[] = [], random = (): number => 0): CapturePolicyCache {
  return new CapturePolicyCache({
    apiKey: 'k',
    endpoint: 'https://ingest.example.com',
    serviceId,
    refreshMs: 60_000,
    random,
    onFetchError: (err) => {
      fetchErrors.push(err);
    },
  });
}

function okPolicyResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      success: true,
      data: {
        capturePolicy: {
          captureErrors: true,
          captureLogs: true,
          captureHttpRequests: true,
        },
      },
    }),
  } as Response;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CapturePolicyCache polling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses bounded jitter for healthy polling delays', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(okPolicyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const policyCache = cache();
    policyCache.start();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(53_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    policyCache.stop();
  });

  it('backs off failed refreshes with a capped exponential delay', async () => {
    vi.useFakeTimers();
    const fetchErrors: unknown[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const policyCache = cache(fetchErrors, () => 0.5);
    policyCache.start();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchErrors).toHaveLength(2);

    policyCache.stop();
  });

  it('honors Retry-After on HTTP 429 responses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '180' }),
      json: async () => ({}),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const policyCache = cache([], () => 0.5);
    policyCache.start();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    policyCache.stop();
  });

  it('resets backoff after a successful refresh', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({}),
      } as Response)
      .mockResolvedValue(okPolicyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const policyCache = cache([], () => 0.5);
    policyCache.start();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    policyCache.stop();
  });

  it('does not start overlapping refresh requests while one is in flight', async () => {
    vi.useFakeTimers();
    let resolveFetch: ((response: Response) => void) | undefined;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pendingFetch);
    vi.stubGlobal('fetch', fetchMock);

    const policyCache = cache();
    policyCache.start();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(okPolicyResponse());
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(54_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    policyCache.stop();
  });
});
