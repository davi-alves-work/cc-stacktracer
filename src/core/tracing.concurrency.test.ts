import { afterEach, describe, expect, it } from 'vitest';
import { flush, init, log, shutdown, withSpan, withTrace } from '../index.js';
import type { BatchTransportPayload } from '../index.js';
import type { SdkSpanRow } from './span-payload.types.js';
import type { StackTraceEvent } from './stacktrace-event.types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(): { spans: SdkSpanRow[]; events: StackTraceEvent[] } {
  const spans: SdkSpanRow[] = [];
  const events: StackTraceEvent[] = [];
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 's',
    environment: 'test',
    serviceId: '00000000-0000-4000-8000-000000000001',
    transport: async (p: BatchTransportPayload) => {
      if (p.kind === 'spans') spans.push(...p.spans);
      else events.push(...p.events);
    },
  });
  return { spans, events };
}

afterEach(async () => {
  await shutdown();
});

describe('withSpan under concurrency', () => {
  it('parents concurrent siblings to the enclosing span, and their children to themselves', async () => {
    const { spans, events } = setup();
    await withTrace('root', async () => {
      await Promise.all([
        withSpan('a', async () => {
          await sleep(10);
        }),
        withSpan('b', async () => {
          await sleep(30);
          await withSpan('b.child', async () => {
            log('inside b.child');
          });
        }),
      ]);
    });
    await flush();
    const by = Object.fromEntries(spans.map((s) => [s.span_name, s]));
    expect(by['a']!.parent_span_id).toBe(by['root']!.span_id);
    expect(by['b']!.parent_span_id).toBe(by['root']!.span_id);
    expect(by['b.child']!.parent_span_id).toBe(by['b']!.span_id);
    const trace = events[0]!.context!.trace as Record<string, unknown>;
    expect(trace.span_id).toBe(by['b.child']!.span_id);
    expect(trace.parent_span_id).toBe(by['b']!.span_id);
  });
});
