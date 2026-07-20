import { describe, expect, it } from 'vitest';
import { parseTraceparent } from './traceparent.js';

describe('parseTraceparent', () => {
  it('parses valid traceparent', () => {
    const r = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01');
    expect(r).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('returns undefined for invalid input', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
  });
});
