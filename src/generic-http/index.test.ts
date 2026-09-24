import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStackTraceClient, init, shutdown } from '../index.js';
import { resetFailOpenState } from '../core/safe-run.js';
import { StackTraceHttpRequest } from './index.js';

describe('StackTraceHttpRequest', () => {
  it('creates a trace context with redacted headers and a route label', () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/clientes/123?token=secret',
      route: '/clientes/:id',
      headers: {
        authorization: 'Bearer secret',
        'user-agent': 'vitest',
      },
    });

    expect(trace.request.method).toBe('GET');
    expect(trace.request.route).toBe('/clientes/:id');
    expect(trace.request.url).toBe('/clientes/123?token=%5BREDACTED%5D');
    expect(trace.request.headers.authorization).toBe('[REDACTED]');
    expect(trace.traceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(trace.rootSpanId).toMatch(/^[a-f0-9]{16}$/u);
    expect(trace.remoteParentSpanId).toBeUndefined();
  });

  it('adopts trace_id and remote parent span id from an inbound traceparent', () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/health',
      route: '/health',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    });

    expect(trace.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(trace.remoteParentSpanId).toBe('00f067aa0ba902b7');
    expect(trace.rootSpanId).toMatch(/^[a-f0-9]{16}$/u);
  });

  it('runs work inside request and trace context', async () => {
    const trace = StackTraceHttpRequest.start({
      method: 'POST',
      url: '/orders',
      route: '/orders',
    });

    const value = await trace.run(async () => 'inside');

    expect(value).toBe('inside');
  });

  it('rejects when the wrapped work throws synchronously', async () => {
    const trace = StackTraceHttpRequest.start({
      method: 'GET',
      url: '/health',
      route: '/health',
    });

    await expect(
      trace.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('StackTraceHttpRequest fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await shutdown();
    resetFailOpenState();
  });

  function initSdk(transport = vi.fn().mockResolvedValue(undefined)): ReturnType<typeof vi.fn> {
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      service: 'svc',
      environment: 'test',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    return transport;
  }

  it('start nunca lança: se o setup falhar, devolve um handle inerte que ainda executa o trabalho', async () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'getHeaderRedactionOptions').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    await expect(trace.run(async () => 'done')).resolves.toBe('done');
    expect(() => trace.end({ statusCode: 200 })).not.toThrow();
  });

  it('end nunca lança quando emitir o span lança', () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    expect(() => trace.end({ statusCode: 200 })).not.toThrow();
  });

  it('com STACKTRACE_DISABLED o handle é inerte e nada é enviado', async () => {
    const transport = initSdk();
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    const trace = StackTraceHttpRequest.start({ method: 'GET', url: '/x', route: '/x' });
    await expect(trace.run(async () => 'done')).resolves.toBe('done');
    trace.end({ statusCode: 200 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport).not.toHaveBeenCalled();
  });
});
