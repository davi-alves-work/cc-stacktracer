import { describe, expect, it } from 'vitest';
import { NULL_TRACE_ID } from './canonical-event-v4.schema.js';
import { coerceToCanonicalInput } from './normalize.js';

const base = {
  type: 'log',
  level: 'info',
  message: 'sem contexto nenhum',
  service: { name: 'svc', version: '1.0.0', environment: 'development' },
};

describe('pickTraceId', () => {
  it('devolve a sentinela quando não há nenhuma fonte de trace', () => {
    expect(coerceToCanonicalInput(base).trace.trace_id).toBe(NULL_TRACE_ID);
  });

  it('não usa x-request-id como trace id — request id não é trace id', () => {
    const input = { ...base, context: { headers: { 'x-request-id': 'req-abc-123' } } };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe(NULL_TRACE_ID);
  });

  it('não usa o requestTraceFallback do lote', () => {
    const out = coerceToCanonicalInput(base, { requestTraceFallback: 'ffffffffffffffffffffffffffffffff' });
    expect(out.trace.trace_id).toBe(NULL_TRACE_ID);
  });

  it('preserva o trace do traceparent de entrada', () => {
    const input = {
      ...base,
      context: { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' } },
    };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('preserva o trace do bloco context.trace (o caminho do ALS)', () => {
    const input = { ...base, context: { trace: { trace_id: '74655e3589e4205969440ccdc13a3b12' } } };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe('74655e3589e4205969440ccdc13a3b12');
  });

  it('preserva o trace de context.trace.traceId (camelCase)', () => {
    const input = { ...base, context: { trace: { traceId: '74655e3589e4205969440ccdc13a3b12' } } };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe('74655e3589e4205969440ccdc13a3b12');
  });

  it('preserva o trace_id no topo do objeto (fora de context)', () => {
    const input = { ...base, trace_id: '74655e3589e4205969440ccdc13a3b12' };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe('74655e3589e4205969440ccdc13a3b12');
  });

  it('preserva o trace de opts.httpTraceparent (sem header no body)', () => {
    const out = coerceToCanonicalInput(base, {
      httpTraceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    });
    expect(out.trace.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('preserva o trace de context.correlation.traceId', () => {
    const input = { ...base, context: { correlation: { traceId: '74655e3589e4205969440ccdc13a3b12' } } };
    expect(coerceToCanonicalInput(input).trace.trace_id).toBe('74655e3589e4205969440ccdc13a3b12');
  });
});
