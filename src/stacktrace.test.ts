import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchTransportPayload } from './core/stacktrace-client.js';
import { StackTraceClient } from './core/stacktrace-client.js';
import { runWithTraceContext } from './core/trace-span-context.js';
import { StackTrace, shutdown } from './index.js';

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
