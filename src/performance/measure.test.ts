import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from '../core/client-ref.js';
import { parseStackTraceInit } from '../core/config.schema.js';
import { StackTraceClient } from '../core/stacktrace-client.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { extractSqlVerb, measure, runQuery } from './measure.js';
import { getStackTraceClient, init, shutdown } from '../index.js';

describe('extractSqlVerb', () => {
  it('parses common SQL verbs', () => {
    expect(extractSqlVerb('UPDATE Usuario SET x=1')).toBe('UPDATE');
    expect(extractSqlVerb('  select * from t')).toBe('SELECT');
    expect(extractSqlVerb('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
  });
});

describe('runQuery enrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setSdkRuntime(null, null);
  });

  it('emits a db span via transport when trace context and tenant/project are set', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const serviceId = '11111111-1111-4111-8111-111111111111';
    const config = parseStackTraceInit({
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
    const client = new StackTraceClient(config);
    setSdkRuntime(client, {
      service: { name: 'svc', version: '1', environment: 'prod' },
      environment: 'prod',
      tenantId,
      projectId,
    });

    const root = randomUUID();
    await runWithTraceContext('trace-runquery-test', root, async () => {
      await runQuery('sqlserver', 'update-user-perfis', async () => 'ok', {
        table: 'UsuarioPerfis',
        sql: 'UPDATE UsuarioPerfis SET x=1',
      });
    });

    await vi.waitFor(() => expect(transport).toHaveBeenCalled());
    const spanCall = transport.mock.calls.find((c) => (c[0] as { kind?: string }).kind === 'spans');
    expect(spanCall).toBeDefined();
    const payload = spanCall?.[0] as { kind: string; spans: Array<{ db_system?: string; db_operation?: string }> };
    expect(payload.spans[0]).toMatchObject({
      db_system: 'sqlserver',
      db_operation: 'UPDATE',
    });
    expect(typeof payload.spans[0]?.duration_us).toBe('number');

    await client.shutdown();
    setSdkRuntime(null, null);
  });

  it('merges a custom attributes option into the emitted span, alongside db_* columns', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const serviceId = '11111111-1111-4111-8111-111111111111';
    const config = parseStackTraceInit({
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
    const client = new StackTraceClient(config);
    setSdkRuntime(client, {
      service: { name: 'svc', version: '1', environment: 'prod' },
      environment: 'prod',
      tenantId,
      projectId,
    });

    const root = randomUUID();
    await runWithTraceContext('trace-runquery-attrs-test', root, async () => {
      await runQuery('postgres', 'invoices.update', async () => 'ok', {
        table: 'invoices',
        attributes: { entity: 'invoice', operation: 'invoices.approve' },
      });
    });

    await vi.waitFor(() => expect(transport).toHaveBeenCalled());
    const spanCall = transport.mock.calls.find((c) => (c[0] as { kind?: string }).kind === 'spans');
    const payload = spanCall?.[0] as {
      kind: string;
      spans: Array<{ db_table?: string; attributes?: Record<string, unknown> | null }>;
    };
    expect(payload.spans[0]?.db_table).toBe('invoices');
    expect(payload.spans[0]?.attributes).toMatchObject({ entity: 'invoice', operation: 'invoices.approve' });

    await client.shutdown();
    setSdkRuntime(null, null);
  });
});

describe('measure attributes option', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setSdkRuntime(null, null);
  });

  it('merges a custom attributes option into the emitted span', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const serviceId = '11111111-1111-4111-8111-111111111111';
    const config = parseStackTraceInit({
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
    const client = new StackTraceClient(config);
    setSdkRuntime(client, {
      service: { name: 'svc', version: '1', environment: 'prod' },
      environment: 'prod',
      tenantId,
      projectId,
    });

    const root = randomUUID();
    await runWithTraceContext('trace-measure-attrs-test', root, async () => {
      await measure('billing.charge', async () => 'ok', {
        kind: 'internal',
        attributes: { entity: 'invoice', operation: 'invoices.approve' },
      });
    });

    await vi.waitFor(() => expect(transport).toHaveBeenCalled());
    const spanCall = transport.mock.calls.find((c) => (c[0] as { kind?: string }).kind === 'spans');
    const payload = spanCall?.[0] as { kind: string; spans: Array<{ attributes?: Record<string, unknown> | null }> };
    expect(payload.spans[0]?.attributes).toMatchObject({ entity: 'invoice', operation: 'invoices.approve' });

    await client.shutdown();
    setSdkRuntime(null, null);
  });
});

describe('measure / runQuery fail-open', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdown();
  });

  function initWithThrowingTelemetry(): void {
    init({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      sendMode: 'immediate',
      transport: vi.fn().mockResolvedValue(undefined),
    });
    const client = getStackTraceClient()!;
    vi.spyOn(client, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    vi.spyOn(client, 'enqueue').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
  }

  it('measure devolve o resultado de fn mesmo se emitir o span lançar', async () => {
    initWithThrowingTelemetry();
    const fn = vi.fn(async () => 'ok');
    await runWithTraceContext('trace-m-fo-1', randomUUID(), async () => {
      await expect(measure('billing.charge', fn)).resolves.toBe('ok');
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('measure relança o erro original pela identidade mesmo se capturar o erro lançar', async () => {
    initWithThrowingTelemetry();
    const appError = new Error('declined');
    await runWithTraceContext('trace-m-fo-2', randomUUID(), async () => {
      await expect(
        measure('billing.charge', () => {
          throw appError;
        }),
      ).rejects.toBe(appError);
    });
  });

  it('runQuery (aninhado) devolve o resultado mesmo se emitir o span lançar', async () => {
    initWithThrowingTelemetry();
    const fn = vi.fn(async () => 1);
    await runWithTraceContext('trace-m-fo-3', randomUUID(), async () => {
      await expect(runQuery('postgres', 'orders.insert', fn)).resolves.toBe(1);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
