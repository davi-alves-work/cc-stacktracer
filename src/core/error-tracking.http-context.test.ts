import { afterEach, describe, expect, it } from 'vitest';
import {
  endHttpRequest,
  flush,
  init,
  log,
  runWithHttpContext,
  shutdown,
  startHttpRequest,
  withSpan,
} from '../index.js';
import type { BatchTransportPayload, StackTraceEvent } from '../index.js';
import { normalizeEventV4 } from '../shared/schema/index.js';
import { toWirePayloadForIngest } from './wire-event.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';

function setup(): StackTraceEvent[] {
  const events: StackTraceEvent[] = [];
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 's',
    environment: 'test',
    serviceId: SERVICE_ID,
    transport: async (p: BatchTransportPayload) => {
      if (p.kind === 'batch') events.push(...p.events);
    },
  });
  return events;
}

const wire = (e: StackTraceEvent) => normalizeEventV4(toWirePayloadForIngest(e), { serviceId: SERVICE_ID });

afterEach(async () => {
  await shutdown();
});

describe('HTTP context on events', () => {
  it.each([404, 500, 200])('the Error Tracking event carries the final status (%i)', async (status) => {
    const events = setup();
    const req = startHttpRequest({ method: 'GET', url: '/users/42?x=1', route: '/users/:id', headers: {} });
    await runWithHttpContext(req, async () => {
      try {
        await withSpan('load', async () => {
          throw new Error('boom');
        });
      } catch {
        /* handled by the app */
      }
    });
    endHttpRequest(req, { statusCode: status });
    await flush();
    const http = wire(events[0]!).metadata.http!;
    expect(http.status_code).toBe(status);
    expect(http.route).toBe('/users/:id');
  });

  it('a log inside a request carries the route template without the method prefix', async () => {
    const events = setup();
    const req = startHttpRequest({
      method: 'POST',
      url: '/orders/7/items',
      route: '/orders/:orderId/items',
      headers: {},
    });
    await runWithHttpContext(req, async () => log('hi'));
    endHttpRequest(req, { statusCode: 201 });
    await flush();
    expect(wire(events[0]!).metadata.http!.route).toBe('/orders/:orderId/items');
  });

  it('without a known template, the route is the masked path, not "METHOD path"', async () => {
    const events = setup();
    const req = startHttpRequest({ method: 'GET', url: '/users/42', headers: {} });
    await runWithHttpContext(req, async () => log('hi'));
    endHttpRequest(req, { statusCode: 200 });
    await flush();
    expect(wire(events[0]!).metadata.http!.route).toBe('/users/:id');
  });
});
