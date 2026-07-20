import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { init, instrumentNodeHttp, shutdown } from '../../index.js';
import { runWithTraceContext } from '../../core/trace-span-context.js';
import type { BatchTransportPayload } from '../../core/stacktrace-client.js';
import type { SdkSpanRow } from '../../core/span-payload.types.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const traceId = '0af7651916cd43dd8448eb211c80319c';
const rootSpanId = 'aaaaaaaaaaaaaaaa';

function setup(): ReturnType<typeof vi.fn> {
  const transport = vi.fn().mockResolvedValue(undefined);
  init({
    apiKey: 'k',
    serviceId,
    service: 'svc',
    environment: 'test',
    endpoint: 'https://ingest.example.com',
    sendMode: 'immediate',
    transport,
  });
  return transport;
}

function spans(transport: ReturnType<typeof vi.fn>): SdkSpanRow[] {
  return transport.mock.calls.flatMap((c) => {
    const payload = c[0] as BatchTransportPayload;
    return payload.kind === 'spans' ? payload.spans : [];
  });
}

describe('outbound node:http instrumentation', () => {
  let restore: () => void = () => {};
  let server: http.Server | undefined;
  let received: string | undefined;

  afterEach(async () => {
    restore();
    restore = () => {};
    if (server !== undefined) {
      const s = server;
      await new Promise<void>((resolve) => s.close(() => resolve()));
      server = undefined;
    }
    received = undefined;
    await shutdown();
  });

  async function startServer(status = 200): Promise<number> {
    server = http.createServer((req, res) => {
      received = typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined;
      res.statusCode = status;
      res.end('ok');
    });
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    return (s.address() as AddressInfo).port;
  }

  it('injects traceparent and records an external span for http.request', async () => {
    const transport = setup();
    const port = await startServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/charge', method: 'POST' }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.span_type).toBe('external');
    expect(span.trace_id).toBe(traceId);
    expect(span.parent_span_id).toBe(rootSpanId);
    expect(span.http_method).toBe('POST');
    expect(span.http_status_code).toBe(200);
    expect(span.status).toBe('ok');
    expect(received).toBe(`00-${traceId}-${span.span_id}-01`);
  });

  it('instruments http.get as well', async () => {
    const transport = setup();
    const port = await startServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
      });
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.http_method).toBe('GET');
    expect(span.http_status_code).toBe(200);
    expect(received).toBe(`00-${traceId}-${span.span_id}-01`);
  });

  it('passes through without a span when there is no active trace context', async () => {
    const transport = setup();
    const port = await startServer();
    restore = instrumentNodeHttp();

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/x' }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });

    expect(spans(transport)).toHaveLength(0);
    expect(received).toBeUndefined();
  });
});
