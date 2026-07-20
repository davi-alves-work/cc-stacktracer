import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, shutdown } from '../index.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { createPrismaStackTracePlugin, createStackTracePrismaQueryExtension } from './prisma.js';
import type { StackTraceContext } from '../core/plugins/types.js';
import type { BatchTransportPayload, StackTraceEvent } from '../index.js';
import type { SdkSpanRow } from '../core/span-payload.types.js';

const serviceId = '11111111-1111-4111-8111-111111111111';
const traceId = '0af7651916cd43dd8448eb211c80319c';
const rootSpanId = 'aaaaaaaaaaaaaaaa';

const pluginCtx: StackTraceContext = { getClient: () => null, getInitConfig: () => null };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function events(transport: ReturnType<typeof vi.fn>): StackTraceEvent[] {
  return transport.mock.calls.flatMap((c) => {
    const payload = c[0] as BatchTransportPayload;
    return payload.kind === 'batch' ? payload.events : [];
  });
}

type AllOperationsHandler = (op: {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

type PrismaMiddleware = (
  params: { model?: string; action: string },
  next: (params: { model?: string; action: string }) => Promise<unknown>,
) => Promise<unknown>;

function extensionHandlers(): { allOperations: AllOperationsHandler; queryRaw: AllOperationsHandler } {
  const ext = createStackTracePrismaQueryExtension();
  return {
    allOperations: ext.query.$allModels.$allOperations as AllOperationsHandler,
    queryRaw: ext.query.$queryRaw as AllOperationsHandler,
  };
}

async function middlewareFromPlugin(): Promise<PrismaMiddleware> {
  let captured: PrismaMiddleware | undefined;
  const prismaFake = {
    $use: (mw: unknown) => {
      captured = mw as PrismaMiddleware;
    },
  };
  await createPrismaStackTracePlugin(prismaFake).init(pluginCtx);
  if (captured === undefined) throw new Error('middleware was not registered');
  return captured;
}

describe('db-prisma plugin', () => {
  afterEach(async () => {
    await shutdown();
  });

  describe('client extension ($extends, Prisma 4.16+)', () => {
    it('measures the real query duration through $allOperations', async () => {
      const transport = setup();
      const { allOperations } = extensionHandlers();

      const result = await runWithTraceContext(traceId, rootSpanId, () =>
        allOperations({
          model: 'User',
          operation: 'findMany',
          args: { where: { active: true } },
          query: async () => {
            await sleep(25);
            return [{ id: 1 }];
          },
        }),
      );

      expect(result).toEqual([{ id: 1 }]);
      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.status).toBe('ok');
      // a span measuring only `await undefined` (the db-lucid bug) reports ~0
      expect(span.duration_us).toBeGreaterThanOrEqual(15_000);
      expect(span.db_duration_us).toBeGreaterThanOrEqual(15_000);
    });

    it('keeps db metadata and trace parenting on the span', async () => {
      const transport = setup();
      const { allOperations } = extensionHandlers();

      await runWithTraceContext(traceId, rootSpanId, () =>
        allOperations({
          model: 'User',
          operation: 'findMany',
          args: {},
          query: async () => [],
        }),
      );

      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.span_type).toBe('db');
      expect(span.span_name).toBe('User.findMany');
      expect(span.db_system).toBe('prisma');
      expect(span.db_operation).toBe('findMany');
      expect(span.db_table).toBe('User');
      expect(span.trace_id).toBe(traceId);
      expect(span.parent_span_id).toBe(rootSpanId);
    });

    it('measures raw queries through the $queryRaw handler', async () => {
      const transport = setup();
      const { queryRaw } = extensionHandlers();

      await runWithTraceContext(traceId, rootSpanId, () =>
        queryRaw({
          operation: '$queryRaw',
          args: {},
          query: async () => {
            await sleep(15);
            return [{ one: 1 }];
          },
        }),
      );

      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.span_name).toBe('$queryRaw');
      expect(span.db_table).toBe('raw');
      expect(span.db_operation).toBe('SELECT');
      expect(span.duration_us).toBeGreaterThanOrEqual(8_000);
    });

    it('marks the span as error and captures an error event with the measured duration when the query rejects', async () => {
      const transport = setup();
      const { allOperations } = extensionHandlers();

      await expect(
        runWithTraceContext(traceId, rootSpanId, () =>
          allOperations({
            model: 'Order',
            operation: 'update',
            args: {},
            query: async () => {
              await sleep(15);
              throw new Error('deadlock victim');
            },
          }),
        ),
      ).rejects.toThrow('deadlock victim');

      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.status).toBe('error');
      expect(span.error_message).toBe('deadlock victim');
      expect(span.duration_us).toBeGreaterThanOrEqual(8_000);

      await vi.waitFor(() => expect(events(transport).length).toBeGreaterThan(0));
      const errorEvent = events(transport).find((e) => e.type === 'error')!;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.message).toBe('deadlock victim');
      const db = (errorEvent.context as { db?: { system?: string; duration_ms?: number } } | undefined)?.db;
      expect(db?.system).toBe('prisma');
      // the error event's own duration must be real too, not ~0
      expect(db?.duration_ms).toBeGreaterThanOrEqual(8);
    });

    it('attributes durations to the right span when queries interleave', async () => {
      const transport = setup();
      const { allOperations } = extensionHandlers();

      await runWithTraceContext(traceId, rootSpanId, async () => {
        const slow = allOperations({
          model: 'Report',
          operation: 'findMany',
          args: {},
          query: async () => {
            await sleep(45);
            return [];
          },
        });
        await sleep(15);
        const fast = allOperations({
          model: 'Session',
          operation: 'count',
          args: {},
          query: async () => {
            await sleep(15);
            return 3;
          },
        });
        await Promise.all([slow, fast]);
      });

      await vi.waitFor(() => expect(spans(transport).length).toBe(2));
      const all = spans(transport);
      const slowSpan = all.find((s) => s.db_table === 'Report')!;
      const fastSpan = all.find((s) => s.db_table === 'Session')!;
      expect(slowSpan).toBeDefined();
      expect(fastSpan).toBeDefined();
      expect(fastSpan.duration_us).toBeGreaterThanOrEqual(8_000);
      expect(slowSpan.duration_us).toBeGreaterThanOrEqual(fastSpan.duration_us + 10_000);
      expect(slowSpan.parent_span_id).toBe(rootSpanId);
      expect(fastSpan.parent_span_id).toBe(rootSpanId);
    });

    it('passes the result through without a span when there is no active trace context', async () => {
      const transport = setup();
      const { allOperations } = extensionHandlers();

      const result = await allOperations({
        model: 'User',
        operation: 'findMany',
        args: {},
        query: async () => [{ id: 7 }],
      });

      expect(result).toEqual([{ id: 7 }]);
      await sleep(30);
      expect(spans(transport)).toHaveLength(0);
    });
  });

  describe('legacy middleware ($use, Prisma <= 5)', () => {
    it('measures the real query duration through the middleware', async () => {
      const transport = setup();
      const middleware = await middlewareFromPlugin();

      const result = await runWithTraceContext(traceId, rootSpanId, () =>
        middleware({ model: 'User', action: 'findMany' }, async () => {
          await sleep(25);
          return [{ id: 1 }];
        }),
      );

      expect(result).toEqual([{ id: 1 }]);
      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.status).toBe('ok');
      expect(span.duration_us).toBeGreaterThanOrEqual(15_000);
      expect(span.span_name).toBe('User.findMany');
      expect(span.db_system).toBe('prisma');
      expect(span.db_table).toBe('User');
      expect(span.parent_span_id).toBe(rootSpanId);
    });

    it('marks the span as error when next rejects', async () => {
      const transport = setup();
      const middleware = await middlewareFromPlugin();

      await expect(
        runWithTraceContext(traceId, rootSpanId, () =>
          middleware({ model: 'Order', action: 'update' }, async () => {
            await sleep(10);
            throw new Error('timeout acquiring connection');
          }),
        ),
      ).rejects.toThrow('timeout acquiring connection');

      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.status).toBe('error');
      expect(span.error_message).toBe('timeout acquiring connection');
      expect(span.duration_us).toBeGreaterThanOrEqual(5_000);
    });

    it('parents interleaved queries to the enclosing span, not to each other', async () => {
      const transport = setup();
      const middleware = await middlewareFromPlugin();

      await runWithTraceContext(traceId, rootSpanId, async () => {
        const slow = middleware({ model: 'Report', action: 'findMany' }, async () => {
          await sleep(30);
          return [];
        });
        await sleep(10);
        const fast = middleware({ model: 'Session', action: 'count' }, async () => {
          await sleep(10);
          return 3;
        });
        await Promise.all([slow, fast]);
      });

      await vi.waitFor(() => expect(spans(transport).length).toBe(2));
      const all = spans(transport);
      expect(all.find((s) => s.db_table === 'Report')!.parent_span_id).toBe(rootSpanId);
      expect(all.find((s) => s.db_table === 'Session')!.parent_span_id).toBe(rootSpanId);
    });

    it('routes raw operations without a model to the raw table', async () => {
      const transport = setup();
      const middleware = await middlewareFromPlugin();

      await runWithTraceContext(traceId, rootSpanId, () => middleware({ action: 'executeRaw' }, async () => 1));

      await vi.waitFor(() => expect(spans(transport).length).toBeGreaterThan(0));
      const span = spans(transport)[0]!;
      expect(span.span_name).toBe('raw.executeRaw');
      expect(span.db_table).toBe('raw');
    });
  });
});
