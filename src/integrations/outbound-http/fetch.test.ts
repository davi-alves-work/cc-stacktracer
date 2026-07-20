import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, instrumentFetch, shutdown } from '../../index.js';
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

describe('outbound fetch instrumentation', () => {
  let restore: () => void = () => {};

  afterEach(async () => {
    restore();
    restore = () => {};
    await shutdown();
    vi.unstubAllGlobals();
  });

  it('injects traceparent with the client span id and records an external span', async () => {
    const transport = setup();
    let injected: string | undefined;
    const original = vi.fn(async (_input: unknown, reqInit?: RequestInit) => {
      injected = new Headers(reqInit?.headers).get('traceparent') ?? undefined;
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch({ internalServiceMap: { 'billing.internal.local': 'billing-service' } });

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const res = await fetch('https://billing.internal.local/charge', { method: 'POST' });
      expect(res.status).toBe(200);
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.span_type).toBe('external');
    expect(span.trace_id).toBe(traceId);
    expect(span.parent_span_id).toBe(rootSpanId);
    expect(span.http_method).toBe('POST');
    expect(span.http_status_code).toBe(200);
    expect(span.status).toBe('ok');
    expect(span.attributes?.['peer.service']).toBe('billing-service');
    // the downstream service must receive THIS client span id as its remote parent
    expect(injected).toBe(`00-${traceId}-${span.span_id}-01`);
  });

  it('never instruments the configured ingestion endpoint', async () => {
    const transport = setup();
    let injected: string | undefined;
    const original = vi.fn(async (_input: unknown, reqInit?: RequestInit) => {
      injected = new Headers(reqInit?.headers).get('traceparent') ?? undefined;
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await fetch('https://ingest.example.com/v1/spans', { method: 'POST' });
    });

    expect(spans(transport)).toHaveLength(0);
    expect(injected).toBeUndefined();
  });

  it('passes through without a span when there is no active trace context', async () => {
    const transport = setup();
    const original = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await fetch('https://api.example.com/x');

    expect(original).toHaveBeenCalledTimes(1);
    expect(spans(transport)).toHaveLength(0);
  });

  it('marks the span as error on a 5xx response', async () => {
    const transport = setup();
    const original = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const res = await fetch('https://api.example.com/x');
      expect(res.status).toBe(503);
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    const span = spans(transport)[0]!;
    expect(span.status).toBe('error');
    expect(span.http_status_code).toBe(503);
    expect(span.attributes?.['peer.kind']).toBe('external_api');
  });

  it('does not double-wrap when instrumentFetch is called twice', async () => {
    const transport = setup();
    const original = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', original);
    const restore1 = instrumentFetch();
    const restore2 = instrumentFetch();
    restore = () => {
      restore2();
      restore1();
    };

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await fetch('https://api.example.com/x');
    });

    await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
    expect(spans(transport)).toHaveLength(1);
  });
});
