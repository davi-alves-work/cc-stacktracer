import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../core/request-context.js';
import { SCHEMA_VERSION } from '../core/stacktrace-event.types.js';
import { buildLogEvent } from './build-log-event.js';

const testService = { name: 'api', version: '1', environment: 'test' };

describe('buildLogEvent', () => {
  it('defaults level to info', () => {
    const e = buildLogEvent({
      service: testService,
      environment: 'test',
      message: 'hello',
    });
    expect(e.schemaVersion).toBe(SCHEMA_VERSION);
    expect(e.level).toBe('info');
  });

  it('respects explicit level', () => {
    const e = buildLogEvent({
      service: testService,
      environment: 'test',
      message: 'warn',
      level: 'warn',
    });
    expect(e.level).toBe('warn');
  });

  it('merges AsyncLocalStorage request snapshot into context', () => {
    const http = { method: 'GET', url: '/x', headers: { a: 'b' } };
    runWithRequestContext(http, () => {
      const e = buildLogEvent({
        service: testService,
        environment: 'test',
        message: 'in request',
        context: { trace: '1' },
      });
      expect(e.context).toEqual({ trace: '1', http, headers: http.headers });
    });
  });
});
