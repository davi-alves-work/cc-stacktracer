import { describe, expect, it } from 'vitest';
import { parseAndCompileCapturePolicy } from '../shared/schema/index.js';
import { SCHEMA_VERSION } from './stacktrace-event.types.js';
import type { LogEvent } from './stacktrace-event.types.js';
import { isEventAllowedByCapturePolicy } from './capture-policy-filter.js';

const testSvc = { name: 's', version: '1', environment: 'e' };

function legacyPolicy(p: {
  captureErrors: boolean;
  captureLogs: boolean;
  captureHttpRequests: boolean;
  logSampleRate?: number;
}) {
  return parseAndCompileCapturePolicy({
    captureErrors: p.captureErrors,
    captureLogs: p.captureLogs,
    captureHttpRequests: p.captureHttpRequests,
    ...(p.logSampleRate !== undefined ? { logSampleRate: p.logSampleRate } : {}),
  });
}

describe('isEventAllowedByCapturePolicy', () => {
  const policy = legacyPolicy({
    captureErrors: true,
    captureLogs: false,
    captureHttpRequests: false,
  });

  it('allows error when errors enabled', () => {
    expect(
      isEventAllowedByCapturePolicy(
        {
          schemaVersion: SCHEMA_VERSION,
          type: 'error',
          service: testSvc,
          environment: 'e',
          timestamp: 't',
          message: 'm',
        },
        policy,
      ),
    ).toBe(true);
  });

  it('blocks log when captureLogs false', () => {
    const log: LogEvent = {
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'e',
      timestamp: 't',
      message: 'hello',
    };
    expect(isEventAllowedByCapturePolicy(log, policy)).toBe(false);
  });

  it('allows critical errors when default errors disabled via V2 rules', () => {
    const deny = parseAndCompileCapturePolicy({
      enabled: true,
      defaultCapture: { error: false },
      rules: [],
    });
    expect(
      isEventAllowedByCapturePolicy(
        {
          schemaVersion: SCHEMA_VERSION,
          type: 'error',
          service: testSvc,
          environment: 'e',
          timestamp: 't',
          message: 'm',
          context: { critical: true },
        },
        deny,
      ),
    ).toBe(true);
  });

  it('applies logSampleRate with injected random via legacy rule', () => {
    const samplePolicy = legacyPolicy({
      captureErrors: true,
      captureLogs: true,
      captureHttpRequests: true,
      logSampleRate: 0.5,
    });
    const log: LogEvent = {
      schemaVersion: SCHEMA_VERSION,
      type: 'log',
      service: testSvc,
      environment: 'e',
      timestamp: 't',
      message: 'hello',
    };
    expect(isEventAllowedByCapturePolicy(log, samplePolicy, () => 0.1)).toBe(true);
    expect(isEventAllowedByCapturePolicy(log, samplePolicy, () => 0.9)).toBe(false);
  });
});
