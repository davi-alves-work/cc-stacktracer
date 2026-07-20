import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, type LogEvent } from './stacktrace-event.types.js';

describe('stacktrace event envelope', () => {
  it('exposes schemaVersion 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('accepts a minimal log event matching the v1 envelope', () => {
    const e: LogEvent = {
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: { name: 's', version: '1', environment: 'e' },
      environment: 'e',
      timestamp: new Date().toISOString(),
      message: 'm',
    };
    expect(e.schemaVersion).toBe(1);
    expect(e.type).toBe('log');
  });
});
