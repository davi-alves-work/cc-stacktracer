import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../core/request-context.js';
import { SCHEMA_VERSION } from '../core/stacktrace-event.types.js';
import { buildErrorEvent } from './build-error-event.js';

const testService = { name: 'api', version: '1', environment: 'test' };

describe('buildErrorEvent', () => {
  it('captures message, name, and stack from Error', () => {
    const err = new Error('something failed');
    const e = buildErrorEvent({
      service: testService,
      environment: 'test',
      error: err,
    });
    expect(e.schemaVersion).toBe(SCHEMA_VERSION);
    expect(e.type).toBe('error');
    expect(e.message).toBe('something failed');
    expect(e.name).toBe('Error');
    expect(e.stack).toContain('build-error-event.test.ts');
  });

  it('merges request snapshot from AsyncLocalStorage', () => {
    const http = { method: 'POST', url: '/fail', headers: {} };
    runWithRequestContext(http, () => {
      const e = buildErrorEvent({
        service: testService,
        environment: 'test',
        error: new Error('nope'),
      });
      expect(e.context?.http).toEqual(http);
    });
  });
});
