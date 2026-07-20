import { describe, expect, it, vi } from 'vitest';
import { createStackTraceClient } from '../index.js';
import { stacktraceAdonisMiddleware, type AdonisHttpContextLike } from './adonis.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

describe('Adonis middleware', () => {
  it('records one root HTTP span when response has on("finish")', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const handlers: Record<string, () => void> = {};
    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/ping',
        headers: () => ({
          'x-request-id': 'abc',
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
        }),
      },
      response: {
        getResponse: () => ({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            handlers[event] = cb;
          },
        }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(handlers.finish).toBeDefined();
    handlers.finish!();

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const kinds = transport.mock.calls.map((c) => c[0]?.kind);
    expect(kinds).toContain('spans');
    expect(kinds).not.toContain('batch');
    const spanPayload = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0];
    expect(spanPayload?.spans?.[0]?.span_type).toBe('http');
    expect(spanPayload?.spans?.[0]?.http_method).toBe('GET');
    expect(spanPayload?.spans?.[0]?.http_status_code).toBe(200);
    // remote parent adoption from the inbound traceparent
    expect(spanPayload?.spans?.[0]?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(spanPayload?.spans?.[0]?.parent_span_id).toBe('00f067aa0ba902b7');
  });

  it('emits the root HTTP span when the connection closes before finish (abort/timeout)', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const handlers: Record<string, () => void> = {};
    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/slow',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({
          statusCode: 200,
          on: (event: string, cb: () => void) => {
            handlers[event] = cb;
          },
        }),
      },
      route: { pattern: '/slow' },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    // Simulate an aborted/timed-out connection: only `close` fires, never `finish`.
    expect(handlers.close).toBeDefined();
    handlers.close!();

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_route).toBe('/slow');
    expect(span?.status).toBe('error');
    expect(span?.http_status_code).toBeNull();
  });

  it('calls onFinish after next() when response has no on()', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'POST',
        url: () => '/echo',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({ statusCode: 201 }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0]?.http_status_code).toBe(201);
  });

  it('normalizes the span http_route without leaking query params', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/callback?code=secret&state=ok&custom_secret=hide',
        headers: () => ({ 'x-custom-secret': 'hide', 'x-visible': 'show' }),
      },
      response: {
        getResponse: () => ({ statusCode: 200 }),
      },
      route: { pattern: '/callback' },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client });
    await middleware(ctx, next);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = transport.mock.calls.find((c) => c[0]?.kind === 'spans')?.[0]?.spans?.[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');
  });

  it('emits nothing when emitHttpRootSpan is false', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const client = createStackTraceClient({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });

    const ctx: AdonisHttpContextLike = {
      request: {
        method: () => 'GET',
        url: () => '/only-event',
        headers: () => ({}),
      },
      response: {
        getResponse: () => ({ statusCode: 200 }),
      },
    };

    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = stacktraceAdonisMiddleware({ client, emitHttpRootSpan: false });
    await middleware(ctx, next);

    // Neither a request event nor a span is produced.
    await new Promise((r) => setTimeout(r, 20));
    expect(transport).not.toHaveBeenCalled();
  });
});
