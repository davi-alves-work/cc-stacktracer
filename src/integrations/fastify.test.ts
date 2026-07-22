import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { createStackTraceClient } from '../index.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import stacktracePlugin from './fastify.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function sentPayloads(transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] {
  return transport.mock.calls.map((call) => call[0] as BatchTransportPayload);
}

describe('Fastify plugin', () => {
  afterEach(async () => {});

  it('records one root HTTP span with status 200 and duration_us >= 0', async () => {
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const spanPayload = sentPayloads(transport).find((item) => item.kind === 'spans');
    expect(spanPayload?.kind).toBe('spans');
    expect(spanPayload?.spans).toHaveLength(1);
    const span = spanPayload?.spans[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_method).toBe('GET');
    expect(span?.http_status_code).toBe(200);
    expect(span?.status).toBe('ok');
    expect(span?.duration_us).toBeGreaterThanOrEqual(0);
    // no inbound traceparent → root span
    expect(span?.parent_span_id).toBeNull();
    // request events are no longer emitted — HTTP timing lives in the span only
    expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(false);

    await app.close();
  });

  it('adopts trace_id and remote parent from an inbound traceparent on the root span', async () => {
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: {
        'x-request-id': 'req-xyz',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      },
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    // remote parent adoption: the inbound traceparent parent-id becomes the root span's parent
    expect(span?.parent_span_id).toBe('00f067aa0ba902b7');
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/);

    await app.close();
  });

  it('emits the root HTTP span even when the client aborts before the response finishes', async () => {
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

    const app = Fastify({ forceCloseConnections: true });
    await app.register(stacktracePlugin, { client });
    // Handler that does not respond before the client gives up: simulates a slow request.
    app.get('/slow', async () => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        t.unref?.();
      });
      return { ok: true };
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/slow', method: 'GET' });
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 100);
    });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.span_type).toBe('http');
    expect(span?.http_route).toBe('/slow');
    // Abort is a transport fact, not an operation failure.
    expect(span?.status).toBe('ok');
    expect(span?.http_aborted).toBe(true);
    expect(span?.http_status_code).toBeNull();
    expect(span?.error_type).toBeNull();

    await app.close();
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

    const app = Fastify();
    await app.register(stacktracePlugin, { client });
    app.get('/callback', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/callback?code=secret&state=ok&custom_secret=hide',
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');

    await app.close();
  });
});
