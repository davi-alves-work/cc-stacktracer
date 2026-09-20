import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from './client-ref.js';
import { parseStackTraceInit } from './config.schema.js';
import { StackTraceClient } from './stacktrace-client.js';
import { getTraceIdFromContext, runWithTraceContext } from './trace-span-context.js';
import { withBusinessContext, withBusinessContextAsync } from './business-context.js';
import { endSpan, startSpan, withSpan, withTrace } from './tracing.js';
import type { SdkSpanRow } from './span-payload.types.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function setupClient(): StackTraceClient {
  const config = parseStackTraceInit({
    apiKey: 'k',
    serviceId,
    service: 'svc',
    environment: 'prod',
    endpoint: 'https://ingest.example.com',
    sendMode: 'immediate',
    transport: vi.fn().mockResolvedValue(undefined),
  });
  const client = new StackTraceClient(config);
  setSdkRuntime(client, { service: { name: 'svc', version: '1', environment: 'prod' }, environment: 'prod' });
  return client;
}

describe('span business-context attribute merge', () => {
  afterEach(() => {
    setSdkRuntime(null, null);
  });

  it('merges active business context (entity/operation) into withSpan attributes, alongside promoted db_* columns', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-1', root, async () => {
      await withBusinessContextAsync({ entity: 'invoice', operation: 'invoices.approve' }, async () => {
        await withSpan('invoices.update', async () => undefined, {
          type: 'db',
          attributes: { db_table: 'invoices' },
        });
      });
    });

    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.db_table).toBe('invoices');
    expect(row.attributes).toEqual({ entity: 'invoice', operation: 'invoices.approve' });
  });

  it('does not add business attributes when no business context is active', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-2', root, async () => {
      await withSpan('plain.query', async () => undefined, { type: 'db', attributes: { db_table: 'invoices' } });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.db_table).toBe('invoices');
    expect(row.attributes).toBeNull();
  });

  it('lets explicit span attributes win over business context on key collision', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-3', root, async () => {
      await withBusinessContextAsync({ entity: 'invoice', operation: 'invoices.approve' }, async () => {
        await withSpan('invoices.custom', async () => undefined, {
          type: 'business',
          attributes: { operation: 'invoices.custom-override' },
        });
      });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.attributes).toEqual({ entity: 'invoice', operation: 'invoices.custom-override' });
  });

  it('also merges business context into startSpan/endSpan (handle-based) spans', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-4', root, () => {
      withBusinessContext({ entity: 'order', operation: 'orders.ship' }, () => {
        const handle = startSpan('orders.ship.step', { type: 'business' });
        endSpan(handle);
      });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.attributes).toEqual({ entity: 'order', operation: 'orders.ship' });
  });
});

describe('withTrace', () => {
  it('abre um trace novo fora de qualquer requisição e emite o span raiz', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await withTrace('job.reprocessa-holerites', () => {
      expect(getTraceIdFromContext()).toMatch(/^[0-9a-f]{32}$/);
    });
    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.span_name).toBe('job.reprocessa-holerites');
    expect(row.span_type).toBe('service');
    expect(row.parent_span_id).toBeNull();
    expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('dentro de um trace ativo vira um span filho — não abre um segundo trace', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await runWithTraceContext('0af7651916cd43dd8448eb211c80319c', 'aaaaaaaaaaaaaaaa', async () => {
      await withTrace('job.interno', () => {});
    });
    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(row.parent_span_id).toBe('aaaaaaaaaaaaaaaa');
  });

  it('propaga a exceção e marca o span como erro', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await expect(
      withTrace('job.quebra', () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.status).toBe('error');
  });

  it('withSpan dentro de withTrace vira filho do span raiz, no mesmo trace', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await withTrace('job.importa-folha', async () => {
      await withSpan('folha.valida-matriculas', () => {}, { type: 'business' });
    });

    expect(enqueueSpan).toHaveBeenCalledTimes(2);
    const rows = enqueueSpan.mock.calls.map((c) => c[0] as SdkSpanRow);
    const child = rows.find((r) => r.span_name === 'folha.valida-matriculas');
    const root = rows.find((r) => r.span_name === 'job.importa-folha');

    expect(root?.parent_span_id).toBeNull();
    expect(child?.parent_span_id).toBe(root?.span_id);
    expect(child?.trace_id).toBe(root?.trace_id);
    expect(child?.span_type).toBe('business');
  });
});
