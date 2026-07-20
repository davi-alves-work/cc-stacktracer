import { describe, expect, it } from 'vitest';
import { extractCorrelationFromHeaders, hasCorrelationData } from './correlation.js';

describe('extractCorrelationFromHeaders', () => {
  it('reads x-request-id', () => {
    const c = extractCorrelationFromHeaders({ 'x-request-id': 'req-1' });
    expect(c.requestId).toBe('req-1');
    expect(hasCorrelationData(c)).toBe(true);
  });

  it('reads x-correlation-id when x-request-id absent', () => {
    const c = extractCorrelationFromHeaders({ 'x-correlation-id': 'corr-2' });
    expect(c.requestId).toBe('corr-2');
  });

  it('merges traceparent', () => {
    const c = extractCorrelationFromHeaders({
      'x-request-id': 'a',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    });
    expect(c.requestId).toBe('a');
    expect(c.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(c.parentSpanId).toBe('00f067aa0ba902b7');
    expect(c.spanId).toBe('00f067aa0ba902b7');
  });

  it('is case-insensitive for header names', () => {
    const c = extractCorrelationFromHeaders({ 'X-Request-Id': 'low' });
    expect(c.requestId).toBe('low');
  });
});
