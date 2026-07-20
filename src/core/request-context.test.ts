import { describe, expect, it } from 'vitest';
import { normalizeEventV4 } from '../shared/schema/index.js';
import { withBusinessContext } from './business-context.js';
import {
  getRequestSnapshot,
  mergeEventContext,
  mergeRequestIntoContext,
  runWithRequestContext,
  runWithRequestContextAsync,
} from './request-context.js';

const snapshot = {
  method: 'POST',
  url: '/orders',
  headers: { 'x-request-id': 'abc' },
};

describe('request context', () => {
  it('exposes the same HTTP snapshot inside runWithRequestContext', () => {
    runWithRequestContext(snapshot, () => {
      expect(getRequestSnapshot()).toEqual(snapshot);
    });
  });

  it('clears outside runWithRequestContext', () => {
    runWithRequestContext(snapshot, () => undefined);
    expect(getRequestSnapshot()).toBeUndefined();
  });

  it('propagates through runWithRequestContextAsync', async () => {
    await runWithRequestContextAsync(snapshot, async () => {
      expect(getRequestSnapshot()?.url).toBe('/orders');
    });
  });

  it('mergeRequestIntoContext adds http, headers, and trace when traceparent is present', () => {
    runWithRequestContext(
      {
        method: 'GET',
        url: '/x',
        headers: {
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
        },
      },
      () => {
        const m = mergeRequestIntoContext();
        expect(m?.http).toBeDefined();
        expect(m?.headers).toEqual(m?.http?.headers);
        expect(m?.trace).toEqual({
          trace_id: '0af7651916cd43dd8448eb211c80319c',
          parent_span_id: '00f067aa0ba902b7',
        });
      },
    );
  });

  it('mergeEventContext adds business from AsyncLocalStorage before explicit context', () => {
    withBusinessContext({ entity: 'usuario', operation: 'update', fields_changed: ['perfis'] }, () => {
      const m = mergeEventContext({ note: 'x' });
      expect(m?.business).toEqual({ entity: 'usuario', operation: 'update', fields_changed: ['perfis'] });
      expect(m?.note).toBe('x');
    });
  });

  it('mergeEventContext lets explicit context override business fields when keys overlap at top level', () => {
    withBusinessContext({ entity: 'a', operation: 'b' }, () => {
      const m = mergeEventContext({ business: { entity: 'override', operation: 'b' } });
      expect(m?.business).toEqual({ entity: 'override', operation: 'b' });
    });
  });

  it('normalizes error with ALS into canonical trace_id from traceparent', () => {
    runWithRequestContext(
      {
        method: 'GET',
        url: '/api/x',
        headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' },
      },
      () => {
        const e = normalizeEventV4(
          {
            schemaVersion: 1,
            type: 'error',
            service: 'svc',
            environment: 'prod',
            timestamp: new Date().toISOString(),
            message: 'fail',
            context: mergeRequestIntoContext({ db: { system: 'mssql', operation: 'op', duration_ms: 1 } }),
          },
          { serviceId: '11111111-1111-4111-8111-111111111111' },
        );
        expect(e.trace.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
        expect(e.trace.parent_span_id).toBe('00f067aa0ba902b7');
      },
    );
  });
});
