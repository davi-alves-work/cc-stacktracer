import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { getStackTraceClient, init, instrumentNodeHttp, shutdown } from '../../index.js';
import { resetFailOpenState } from '../../core/safe-run.js';
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFailOpenState();
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

  it('instrumenta quem importa request por nome no ESM (import { request } from "node:http")', async () => {
    const transport = setup();
    const port = await startServer();
    restore = instrumentNodeHttp();
    const esm = await import('node:http');

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = esm.request({ host: '127.0.0.1', port, path: '/webhook', method: 'POST' }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.http_method).toBe('POST');
    expect(received).toBe(`00-${traceId}-${span.span_id}-01`);
  });

  it('os bindings ESM de http e https seguem o patch, e o uninstrument devolve os originais', async () => {
    const require = createRequire(import.meta.url);
    const before = { request: (await import('node:http')).request, get: (await import('node:https')).get };

    restore = instrumentNodeHttp();
    expect((await import('node:http')).get).toBe(require('node:http').get);
    expect((await import('node:https')).request).toBe(require('node:https').request);
    expect((await import('node:https')).get).toBe(require('node:https').get);

    restore();
    restore = () => {};
    expect((await import('node:http')).request).toBe(before.request);
    expect((await import('node:https')).get).toBe(before.get);
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

  async function startHeaderEchoServer(): Promise<{ port: number; seen: http.IncomingHttpHeaders[] }> {
    const seen: http.IncomingHttpHeaders[] = [];
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.end('ok');
    });
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    return { port: (s.address() as AddressInfo).port, seen };
  }

  it('mantém headers passados no formato array (nunca descarta Authorization)', async () => {
    setup();
    const { port, seen } = await startHeaderEchoServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        // No formato array o Node não acrescenta `Host` sozinho — quem usa esse formato manda o próprio.
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/x',
            headers: ['Host', `127.0.0.1:${port}`, 'Authorization', 'Bearer abc'],
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end();
      });
    });
    expect(seen[0]?.authorization).toBe('Bearer abc');
  });

  it('deixa o Node descartar o corpo quando a app não registrou listener de resposta', async () => {
    setup();
    const port = await startServer();
    restore = instrumentNodeHttp();
    let req: http.ClientRequest | undefined;

    await runWithTraceContext(traceId, rootSpanId, async () => {
      req = http.request({ host: '127.0.0.1', port, path: '/fire-and-forget' });
      req.end();
    });
    await vi.waitFor(() => expect((req as unknown as { res?: http.IncomingMessage }).res?.readableFlowing).toBe(true));
  });

  it('não consome o corpo quando a app escuta via callback', async () => {
    setup();
    const port = await startServer();
    restore = instrumentNodeHttp();
    let captured: http.IncomingMessage | undefined;

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/later' }, (res) => {
          captured = res;
          resolve();
        });
        req.end();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured?.readableFlowing).toBeNull();
    captured?.resume();
  });

  it('um erro de requisição sem listener da app continua lançando, como no Node', async () => {
    setup();
    const port = await startServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/x' });
      const err = new Error('socket hang up');
      expect(() => req.emit('error', err)).toThrow(err);
      req.on('error', () => {});
      req.destroy();
    });
  });

  it('não lança quando a app trata o erro', async () => {
    setup();
    const port = await startServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/x' });
      req.on('error', () => {});
      expect(() => req.emit('error', new Error('handled'))).not.toThrow();
      req.destroy();
    });
  });

  it('a requisição segue normal quando emitir o span lança', async () => {
    setup();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const port = await startServer();
    restore = instrumentNodeHttp();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/x' }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
    });
  });

  it('não faz patch de node:http com STACKTRACE_DISABLED', () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const before = http.request;
    restore = instrumentNodeHttp();
    expect(http.request).toBe(before);
  });
});
