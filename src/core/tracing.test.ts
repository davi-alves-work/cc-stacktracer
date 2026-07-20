import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from './client-ref.js';
import { parseStackTraceInit } from './config.schema.js';
import { StackTraceClient } from './stacktrace-client.js';
import { runWithTraceContext } from './trace-span-context.js';
import { withBusinessContext, withBusinessContextAsync } from './business-context.js';
import { endSpan, startSpan, withSpan } from './tracing.js';
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
