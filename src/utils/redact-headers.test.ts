import { describe, it, expect } from 'vitest';
import { redactHeaders } from './redact-headers.js';

describe('redactHeaders', () => {
  it('redacts authorization value but keeps key', () => {
    expect(redactHeaders({ Authorization: 'secret', 'X-Custom': 'ok' })).toEqual({
      authorization: '[REDACTED]',
      'x-custom': 'ok',
    });
  });

  it('redacts extra sensitive keys from options', () => {
    expect(redactHeaders({ 'X-Custom': 'keep', 'X-Special': 'hide' }, { extraSensitiveKeys: ['x-special'] })).toEqual({
      'x-custom': 'keep',
      'x-special': '[REDACTED]',
    });
  });

  it('redacts extra sensitive keys case-insensitively', () => {
    expect(redactHeaders({ 'X-Custom-Secret': 'hide' }, { extraSensitiveKeys: ['x-custom-secret'] })).toEqual({
      'x-custom-secret': '[REDACTED]',
    });
  });

  it('truncates long header values after redaction', () => {
    const long = 'x'.repeat(600);
    const out = redactHeaders({ 'x-custom': long }, { maxValueLength: 100 });
    expect(out['x-custom']?.length).toBe(101);
    expect(out['x-custom']?.endsWith('…')).toBe(true);
  });

  it('does not truncate when maxValueLength is 0', () => {
    const long = 'y'.repeat(600);
    const out = redactHeaders({ 'x-custom': long }, { maxValueLength: 0 });
    expect(out['x-custom']).toBe(long);
  });
});
