import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { createStackTraceClient } from '../index.js';
import type { BatchTransportPayload } from '../core/stacktrace-client.js';
import { stacktraceExpressMiddleware } from './express.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function sentPayloads(transport: ReturnType<typeof vi.fn>): BatchTransportPayload[] {
  return transport.mock.calls.map((call) => call[0] as BatchTransportPayload);
}

describe('Express middleware', () => {
  it('records one root HTTP span with status and duration', async () => {
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);

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
    expect(span?.parent_span_id).toBeNull();
    expect(sentPayloads(transport).some((item) => item.kind === 'batch')).toBe(false);
  });

  it('adopts trace_id and remote parent from an inbound traceparent', async () => {
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app)
      .get('/health')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01');
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span?.parent_span_id).toBe('00f067aa0ba902b7');
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    // Handler that never sends a response: simulates a slow request the client gives up on.
    app.get('/slow', () => {
      /* intentionally never responds */
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

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

    await new Promise<void>((resolve) => server.close(() => resolve()));
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

    const app = express();
    app.use(stacktraceExpressMiddleware({ client }));
    app.get('/callback', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/callback?code=secret&state=ok&custom_secret=hide');
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const span = sentPayloads(transport).find((item) => item.kind === 'spans')?.spans[0];
    expect(span?.http_route).toBe('/callback');
    expect(span?.http_route).not.toContain('secret');
  });
});
