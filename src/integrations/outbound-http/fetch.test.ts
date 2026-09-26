import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStackTraceClient, init, instrumentFetch, shutdown } from '../../index.js';
import { resetFailOpenState } from '../../core/safe-run.js';
import { runWithTraceContext } from '../../core/trace-span-context.js';
import { withTrace } from '../../core/tracing.js';
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
    vi.restoreAllMocks();
    await shutdown();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetFailOpenState();
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

  it('3.0: erro por status (503) marca o span, mas nao vira evento — sem excecao nao ha issue', async () => {
    const transport = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    restore = instrumentFetch();
    await withTrace('job.sync', async () => {
      await fetch('https://api.example.com/sync');
    });
    await vi.waitFor(() => expect(spans(transport).some((s) => s.span_type === 'external')).toBe(true));
    const span = spans(transport).find((s) => s.span_type === 'external')!;
    expect(span).toMatchObject({ status: 'error', error_type: 'HttpError', http_status_code: 503 });
    expect(transport.mock.calls.some((c) => (c[0] as BatchTransportPayload).kind === 'batch')).toBe(false);
  });

  it('3.0: 404 de API externa nao e erro por padrao', async () => {
    const transport = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    restore = instrumentFetch();
    await withTrace('job.lookup', async () => {
      await fetch('https://api.example.com/items/1');
    });
    await vi.waitFor(() => expect(spans(transport).some((s) => s.span_type === 'external')).toBe(true));
    expect(spans(transport).find((s) => s.span_type === 'external')?.status).toBe('ok');
  });

  it('3.0: httpClientErrorStatuses=400-599 faz o 404 contar como erro', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    init({
      apiKey: 'k',
      serviceId,
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      httpClientErrorStatuses: '400-599',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    restore = instrumentFetch();
    await withTrace('job.lookup', async () => {
      await fetch('https://api.example.com/items/1');
    });
    await vi.waitFor(() => expect(spans(transport).some((s) => s.span_type === 'external')).toBe(true));
    expect(spans(transport).find((s) => s.span_type === 'external')?.status).toBe('error');
  });

  it('3.0: falha de rede e excecao de verdade: vira UM evento, no span de saida', async () => {
    const transport = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    restore = instrumentFetch();
    await withTrace('job.sync', async () => {
      await fetch('https://api.example.com/sync').catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(transport.mock.calls.some((c) => (c[0] as BatchTransportPayload).kind === 'batch')).toBe(true),
    );
    const external = spans(transport).find((s) => s.span_type === 'external')!;
    const events = transport.mock.calls.flatMap((c) => {
      const p = c[0] as BatchTransportPayload;
      return p.kind === 'batch' ? p.events : [];
    });
    expect(events.map((e) => e.message)).toEqual(['fetch failed']);
    expect((events[0]?.context?.trace as { span_id?: string } | undefined)?.span_id).toBe(external.span_id);
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

  it('devolve a resposta real e chama a rede uma vez mesmo se emitir o span lançar', async () => {
    setup();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const original = vi.fn(async () => new Response('paid', { status: 201 }));
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const res = await fetch('https://payments.example.com/charge', { method: 'POST', body: '{}' });
      expect(res.status).toBe(201);
      expect(await res.text()).toBe('paid');
    });
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('relança o erro de rede original pela identidade mesmo se emitir o span lançar', async () => {
    setup();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const networkError = new TypeError('fetch failed');
    const original = vi.fn(async () => {
      throw networkError;
    });
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await expect(fetch('https://api.example.com/x')).rejects.toBe(networkError);
    });
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('se o setup do SDK lançar, faz a chamada intocada — uma vez, com os argumentos da app', async () => {
    setup();
    const original = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('ok'));
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();
    const trickyInit = {
      method: 'POST',
      get headers(): HeadersInit {
        throw new Error('boom');
      },
    } as RequestInit;

    await runWithTraceContext(traceId, rootSpanId, async () => {
      const res = await fetch('https://api.example.com/x', trickyInit);
      expect(res.status).toBe(200);
    });
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]?.[1]).toBe(trickyInit);
  });

  it('init.headers substitui os headers do Request, como manda a spec do Fetch', async () => {
    setup();
    let sent: Headers | undefined;
    const original = vi.fn(async (_input: unknown, reqInit?: RequestInit) => {
      sent = new Headers(reqInit?.headers);
      return new Response('ok');
    });
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();

    await runWithTraceContext(traceId, rootSpanId, async () => {
      await fetch(new Request('https://api.example.com/x', { headers: { 'x-from-request': '1' } }), {
        headers: { 'x-from-init': '2' },
      });
    });
    expect(sent?.get('x-from-init')).toBe('2');
    expect(sent?.get('x-from-request')).toBeNull();
    expect(sent?.get('traceparent')).toMatch(/^00-/);
  });

  it('não faz patch do fetch com STACKTRACE_DISABLED', () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    restore = instrumentFetch();
    expect(globalThis.fetch).toBe(original);
  });
});
