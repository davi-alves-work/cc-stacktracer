import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { init, instrumentNodeHttp, shutdown, withSpan } from '../../index.js';
import stacktracePlugin from '../fastify.js';
import { runWithTraceContext } from '../../core/trace-span-context.js';
import type { BatchTransportPayload } from '../../core/stacktrace-client.js';
import type { SdkSpanRow } from '../../core/span-payload.types.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const traceId = '0af7651916cd43dd8448eb211c80319c';
const aRootSpanId = 'aaaaaaaaaaaaaaaa';

function spans(transport: ReturnType<typeof vi.fn>): SdkSpanRow[] {
  return transport.mock.calls.flatMap((c) => {
    const payload = c[0] as BatchTransportPayload;
    return payload.kind === 'spans' ? payload.spans : [];
  });
}

describe('distributed trace e2e (service A → service B over node:http)', () => {
  let restore: () => void = () => {};
  let appB: FastifyInstance | undefined;

  afterEach(async () => {
    restore();
    restore = () => {};
    if (appB !== undefined) {
      await appB.close();
      appB = undefined;
    }
    await shutdown();
  });

  it('produces one trace with service B parented to service A outbound span, and a DB span under B', async () => {
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

    // Service B: a real Fastify app with the inbound plugin + a DB child span in the handler.
    appB = Fastify();
    await appB.register(stacktracePlugin);
    appB.get('/charge', async () => {
      await withSpan('SELECT payments', async () => undefined, {
        type: 'db',
        attributes: { db_system: 'postgres', db_operation: 'SELECT', db_table: 'payments' },
      });
      return { ok: true };
    });
    await appB.listen({ port: 0, host: '127.0.0.1' });
    const portB = (appB.server.address() as AddressInfo).port;

    // Service A: within A's request trace scope, make an instrumented outbound call to B.
    restore = instrumentNodeHttp();
    await runWithTraceContext(traceId, aRootSpanId, async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${portB}/charge`, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
      });
    });

    // Wait until A-outbound + B-root + B-db spans have all been delivered.
    await vi.waitFor(() => {
      const s = spans(transport);
      expect(s.some((x) => x.span_type === 'external')).toBe(true);
      expect(s.some((x) => x.span_type === 'http')).toBe(true);
      expect(s.some((x) => x.span_type === 'db')).toBe(true);
    });

    const all = spans(transport);
    const aOutbound = all.find((s) => s.span_type === 'external')!;
    const bRoot = all.find((s) => s.span_type === 'http')!;
    const bDb = all.find((s) => s.span_type === 'db')!;

    // One trace id across every span.
    expect(all.every((s) => s.trace_id === traceId)).toBe(true);
    // Cross-service edge: B's server span is a child of A's outbound client span.
    expect(bRoot.parent_span_id).toBe(aOutbound.span_id);
    // A's outbound span is a child of A's request root.
    expect(aOutbound.parent_span_id).toBe(aRootSpanId);
    // DB span is a child of B's server span.
    expect(bDb.parent_span_id).toBe(bRoot.span_id);
  });
});
