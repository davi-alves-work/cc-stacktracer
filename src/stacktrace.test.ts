import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchTransportPayload } from './core/stacktrace-client.js';
import { StackTraceClient } from './core/stacktrace-client.js';
import { runWithTraceContext } from './core/trace-span-context.js';
import { getStackTraceClient, StackTrace, shutdown } from './index.js';
import { resetFailOpenState } from './core/safe-run.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

describe('StackTrace facade', () => {
  afterEach(async () => {
    await shutdown();
  });

  it('measure does not call transport on success without trace context (spans-only)', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    StackTrace.init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    await StackTrace.measure('op', async () => 1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('measure enqueues span batch when trace context and tenant/project are set', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    StackTrace.init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
      tenantId,
      projectId,
    });
    const root = randomUUID();
    await runWithTraceContext('trace-measure-facade', root, async () => {
      await StackTrace.measure('op', async () => 1);
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const payload = transport.mock.calls[0]?.[0] as BatchTransportPayload;
    expect(payload.kind).toBe('spans');
    expect(payload.spans).toHaveLength(1);
    expect(payload.spans[0]).toMatchObject({
      trace_id: 'trace-measure-facade',
      span_name: 'op',
      span_type: 'business',
      tenant_id: tenantId,
      project_id: projectId,
    });
  });

  it('init then log enqueues event to transport', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    StackTrace.init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport,
    });
    StackTrace.log('hello');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const payload = transport.mock.calls[0]?.[0] as BatchTransportPayload;
    expect(payload.kind).toBe('batch');
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ type: 'log', message: 'hello' });
  });

  it('calls detachScheduling on previous client when init is invoked twice', () => {
    const detachSpy = vi.spyOn(StackTraceClient.prototype, 'detachScheduling');
    try {
      const transport = vi.fn().mockResolvedValue(undefined);
      const base = {
        apiKey: 'k',
        serviceId,
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        sendMode: 'immediate' as const,
        transport,
      };
      StackTrace.init({ ...base, service: 'svc-a' });
      StackTrace.init({ ...base, service: 'svc-b' });
      expect(detachSpy).toHaveBeenCalledTimes(1);
    } finally {
      detachSpy.mockRestore();
    }
  });
});

describe('API pública é fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await shutdown();
  });

  function initSdk(): void {
    StackTrace.init({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('captureException, log e logStructured nunca lançam', () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'enqueue').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    expect(() => StackTrace.captureException(new Error('x'))).not.toThrow();
    expect(() => StackTrace.log('x')).not.toThrow();
    expect(() => StackTrace.logStructured({ level: 'info', message: 'x' })).not.toThrow();
  });

  it('setUser aceita email null vindo do banco', () => {
    expect(() => StackTrace.setUser({ id: 'u1', email: null as unknown as string })).not.toThrow();
  });

  it('flush nunca rejeita', async () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'flush').mockRejectedValue(new Error('down'));
    await expect(StackTrace.flush()).resolves.toBeUndefined();
  });

  it('flush resolve no prazo mesmo com o envio pendurado', async () => {
    initSdk();
    vi.spyOn(getStackTraceClient()!, 'flush').mockReturnValue(new Promise<void>(() => {}));
    vi.useFakeTimers();
    const pending = StackTrace.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('init é fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await shutdown();
    resetFailOpenState();
  });

  it('config inválida não lança: um console.error sem segredos, e o SDK fica no-op', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      StackTrace.init({ apiKey: 'sk_live_secret', serviceId: 'not-a-uuid', endpoint: 'https://ingest.example.com' }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain('serviceId');
    expect(message).not.toContain('sk_live_secret');
    expect(getStackTraceClient()).toBeNull();
    expect(() => StackTrace.log('segue a vida')).not.toThrow();
  });

  it('STACKTRACE_CAPTURE_POLICY_REFRESH_MS inválido não derruba o boot', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('STACKTRACE_CAPTURE_POLICY_REFRESH_MS', '60s');
    expect(() => StackTrace.init({ apiKey: 'k', serviceId, endpoint: 'https://ingest.example.com' })).not.toThrow();
    expect(getStackTraceClient()).toBeNull();
  });

  it('auto() resolve e não instala nada quando a config é inválida', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchBefore = globalThis.fetch;
    await expect(
      StackTrace.auto({
        apiKey: '',
        serviceId,
        endpoint: 'https://ingest.example.com',
        outboundHttp: { instrumentFetch: true },
      }),
    ).resolves.toBeUndefined();
    expect(globalThis.fetch).toBe(fetchBefore);
  });

  it('STACKTRACE_DISABLED=1 torna o init um no-op antes mesmo de ler a config', () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    StackTrace.init({ apiKey: '', serviceId: 'quebrado', endpoint: 'nope' });
    expect(error).not.toHaveBeenCalled();
    expect(getStackTraceClient()).toBeNull();
  });

  it('manda falhas internas para o logger configurado', () => {
    const warn = vi.fn();
    StackTrace.init({
      apiKey: 'k',
      serviceId,
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport: vi.fn().mockResolvedValue(undefined),
      logger: { warn },
    });
    vi.spyOn(getStackTraceClient()!, 'enqueue').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    StackTrace.log('x');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'log', error: 'telemetry boom' }),
      expect.stringContaining('internal failure'),
    );
  });
});
