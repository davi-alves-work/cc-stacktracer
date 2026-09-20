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

describe('traceparent inválido pela W3C', () => {
  it('rejeita trace-id all-zero', () => {
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
  });

  it('rejeita parent-id all-zero', () => {
    expect(parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01')).toBeUndefined();
  });

  it('continua aceitando um traceparent válido', () => {
    expect(parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01')?.traceId).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
  });
});
