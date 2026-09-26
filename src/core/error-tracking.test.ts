import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from './client-ref.js';
import { parseStackTraceInit } from './config.schema.js';
import { StackTraceClient } from './stacktrace-client.js';
import { resolveErrorTrackingConfig } from './error-tracking-config.js';
import {
  completeLocalRoot,
  isErrorCaptured,
  markErrorCaptured,
  recordBoundaryError,
  recordSpanError,
  resetErrorTrackingState,
} from './error-tracking.js';
import { runWithTraceContext } from './trace-span-context.js';

const T = 'a'.repeat(32);
const ROOT = 'b'.repeat(16);

function setup(errorTracking = true) {
  const client = new StackTraceClient(
    parseStackTraceInit({
      apiKey: 'k',
      serviceId: '11111111-1111-4111-8111-111111111111',
      endpoint: 'https://ingest.example.com',
      sendMode: 'batch',
      transport: vi.fn().mockResolvedValue(undefined),
    }),
  );
  setSdkRuntime(client, {
    service: { name: 'svc', version: '1', environment: 'prod' },
    environment: 'prod',
    endpoint: 'https://ingest.example.com',
    errorTracking: resolveErrorTrackingConfig({ errorTracking, env: {}, warn: vi.fn() }),
  });
  return vi.spyOn(client, 'enqueue');
}

type EmittedEvent = {
  message: string;
  context?: { trace?: { span_id?: string }; captured_by?: string; http?: { response_status_code?: number } };
};

const events = (enqueue: ReturnType<typeof setup>): EmittedEvent[] =>
  enqueue.mock.calls.map(([e]) => e as unknown as EmittedEvent);

describe('error tracking', () => {
  beforeEach(() => resetErrorTrackingState());
  afterEach(() => setSdkRuntime(null, null));

  it('o mesmo erro subindo por tres spans vira UM evento, no span mais alto', () => {
    const enqueue = setup();
    const err = new Error('S3 nao configurado');
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: 'd'.repeat(16), depth: 2, error: err });
      recordSpanError({ traceId: T, spanId: 'd'.repeat(16), parentSpanId: ROOT, depth: 1, error: err });
      recordSpanError({ traceId: T, spanId: ROOT, parentSpanId: null, depth: 0, error: err });
      expect(enqueue).not.toHaveBeenCalled();
      completeLocalRoot({ traceId: T, rootSpanId: ROOT });
    });
    expect(events(enqueue)).toHaveLength(1);
    expect(events(enqueue)[0]).toMatchObject({
      message: 'S3 nao configurado',
      context: { trace: { span_id: ROOT }, captured_by: 'error-tracking' },
    });
    expect(isErrorCaptured(err)).toBe(true);
  });

  it('erros diferentes: fica so o do span mais alto (top-most, como o Datadog)', () => {
    const enqueue = setup();
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({
        traceId: T,
        spanId: 'c'.repeat(16),
        parentSpanId: 'd'.repeat(16),
        depth: 2,
        error: new Error('inner'),
      });
      recordSpanError({ traceId: T, spanId: 'd'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('outer') });
      completeLocalRoot({ traceId: T, rootSpanId: ROOT });
    });
    expect(events(enqueue).map((e) => e.message)).toEqual(['outer']);
  });

  it('empate de profundidade: fica o primeiro', () => {
    const enqueue = setup();
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('first') });
      recordSpanError({ traceId: T, spanId: 'd'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('second') });
      completeLocalRoot({ traceId: T, rootSpanId: ROOT });
    });
    expect(events(enqueue).map((e) => e.message)).toEqual(['first']);
  });

  it('excecao de borda com 5xx vira o evento, no span raiz, com o status da resposta', () => {
    const enqueue = setup();
    const err = new Error('boom');
    runWithTraceContext(T, ROOT, () => recordBoundaryError(err));
    const out = completeLocalRoot({ traceId: T, rootSpanId: ROOT, statusCode: 500 });
    expect(out.boundaryError).toBe(err);
    expect(events(enqueue)).toHaveLength(1);
    expect(events(enqueue)[0]).toMatchObject({ message: 'boom', context: { trace: { span_id: ROOT } } });
  });

  it('excecao de borda com 4xx nao vira evento', () => {
    const enqueue = setup();
    runWithTraceContext(T, ROOT, () => recordBoundaryError(new Error('not found')));
    const out = completeLocalRoot({ traceId: T, rootSpanId: ROOT, statusCode: 404 });
    expect(out.boundaryError).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('com 4xx na borda, o erro de um span interno continua saindo', () => {
    const enqueue = setup();
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('db') });
      recordBoundaryError(new Error('not found'));
    });
    completeLocalRoot({ traceId: T, rootSpanId: ROOT, statusCode: 404 });
    expect(events(enqueue).map((e) => e.message)).toEqual(['db']);
  });

  it('erro ja enviado a mao nao duplica', () => {
    const enqueue = setup();
    const err = new Error('x');
    markErrorCaptured(err);
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({ traceId: T, spanId: ROOT, parentSpanId: null, depth: 0, error: err });
      completeLocalRoot({ traceId: T, rootSpanId: ROOT });
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('span que termina depois da raiz emite na hora', () => {
    const enqueue = setup();
    runWithTraceContext(T, ROOT, () => completeLocalRoot({ traceId: T, rootSpanId: ROOT }));
    runWithTraceContext(T, ROOT, () =>
      recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('late') }),
    );
    expect(events(enqueue).map((e) => e.message)).toEqual(['late']);
  });

  it('sem trace ativo o erro sai na hora', () => {
    const enqueue = setup();
    recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: null, depth: 0, error: new Error('solto') });
    expect(events(enqueue).map((e) => e.message)).toEqual(['solto']);
  });

  it('desligado: nao emite, mas a excecao de borda continua disponivel para o span raiz', () => {
    const enqueue = setup(false);
    const err = new Error('boom');
    runWithTraceContext(T, ROOT, () => {
      recordSpanError({ traceId: T, spanId: 'c'.repeat(16), parentSpanId: ROOT, depth: 1, error: new Error('db') });
      recordBoundaryError(err);
    });
    expect(completeLocalRoot({ traceId: T, rootSpanId: ROOT, statusCode: 503 }).boundaryError).toBe(err);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
