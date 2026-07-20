import { describe, expect, it } from 'vitest';
import { sanitizeStackTrace } from './sanitize-stack.js';

describe('sanitizeStackTrace', () => {
  it('redacts Windows absolute paths in frames', () => {
    const stack = `Error: fail
    at handler (D:\\Users\\dev\\app\\src\\foo.ts:10:5)`;
    expect(sanitizeStackTrace(stack)).not.toContain('D:\\Users');
    expect(sanitizeStackTrace(stack)).toContain('(...)');
  });
});
