import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendWithFetch } from './default-fetch-transport.js';

describe('sendWithFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('invokes global fetch once with POST, headers, and body', async () => {
    const calls: { input: RequestInfo; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await sendWithFetch({
      url: 'https://ingest.example.com/v1/events',
      headers: { 'x-api-key': 'secret' },
      body: '{"ok":true}',
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.input).toBe('https://ingest.example.com/v1/events');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"ok":true}');
    const headers = new Headers(calls[0]?.init?.headers as HeadersInit);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe('secret');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('forces application/json even when input headers set a different Content-Type', async () => {
    const calls: { init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      calls.push({ init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await sendWithFetch({
      url: 'https://ingest.example.com/v1/events',
      headers: {
        'Content-Type': 'text/plain',
        'x-api-key': 'secret',
      },
      body: '{}',
    });

    const h = new Headers(calls[0]?.init?.headers as HeadersInit);
    expect(h.get('content-type')).toBe('application/json');
  });
});
