import { describe, expect, it, vi } from 'vitest';
import { eventV1ToV4 } from './normalize-event.js';
import type { CanonicalInput } from '../schema/event.schema.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function baseInput(overrides: Partial<CanonicalInput> = {}): CanonicalInput {
  return {
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2026-07-20T00:00:00.000Z',
    type: 'log',
    level: 'info',
    message: 'hi',
    service: { name: 'svc', version: '1.0.0', environment: 'prod' },
    trace: { trace_id: '74655e3589e4205969440ccdc13a3b12' },
    ...overrides,
  };
}

describe('structureMetadataFromV1Event dropped-key diagnostics (via eventV1ToV4)', () => {
  it('invokes onDroppedContextKey for an object value under an unrecognized top-level key', () => {
    const onDropped = vi.fn();
    eventV1ToV4(baseInput({ metadata: { context: { http: { method: 'GET' } } } }), {
      serviceId,
      onDroppedContextKey: onDropped,
    });
    expect(onDropped).toHaveBeenCalledWith('context');
    expect(onDropped).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onDroppedContextKey for scalar values (they are promoted to tags instead)', () => {
    const onDropped = vi.fn();
    const result = eventV1ToV4(baseInput({ metadata: { userId: 'u-1', accountId: 'acc-1' } }), {
      serviceId,
      onDroppedContextKey: onDropped,
    });
    expect(onDropped).not.toHaveBeenCalled();
    expect(result.metadata.tags).toMatchObject({ userId: 'u-1', accountId: 'acc-1' });
  });

  it('does not invoke onDroppedContextKey for recognized structured blocks (business, correlation)', () => {
    const onDropped = vi.fn();
    const result = eventV1ToV4(
      baseInput({
        metadata: {
          business: { entity: 'invoice', operation: 'approve' },
          correlation: { requestId: 'r-1' },
        },
      }),
      { serviceId, onDroppedContextKey: onDropped },
    );
    expect(onDropped).not.toHaveBeenCalled();
    expect(result.metadata.business).toEqual({ entity: 'invoice', operation: 'approve' });
  });

  it('does not throw and behaves identically when onDroppedContextKey is omitted', () => {
    const result = eventV1ToV4(baseInput({ metadata: { context: { nested: true } } }), { serviceId });
    expect(result.metadata.tags).toBeUndefined();
  });
});
