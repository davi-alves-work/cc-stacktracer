import { describe, expect, it } from 'vitest';
import { compileCapturePolicy, parseAndCompileCapturePolicy } from '../../shared/schema/index.js';
import { CaptureGate } from './CaptureGate.js';
import type { CapturePolicyCache } from './CapturePolicyCache.js';
import type { CompiledCapturePolicy } from '../../shared/schema/index.js';
import type { SdkSpanRow } from '../../core/span-payload.types.js';

function mockCache(compiled: CompiledCapturePolicy): CapturePolicyCache {
  return { getPolicy: () => compiled } as unknown as CapturePolicyCache;
}

describe('CaptureGate', () => {
  it('maps http and span defaults via V2', () => {
    const g = new CaptureGate({
      cache: mockCache(
        compileCapturePolicy({
          enabled: true,
          defaultCapture: { http: false, span: false },
        }),
      ),
      defaultServiceName: 'svc',
      defaultServiceId: '11111111-1111-4111-8111-111111111111',
      defaultEnvironment: 'prod',
    });
    expect(g.shouldCapture('http', {})).toBe(false);
    expect(g.shouldCapture('span', {})).toBe(false);
  });

  it('uses http vs span defaults for span rows', () => {
    const g = new CaptureGate({
      cache: mockCache(
        parseAndCompileCapturePolicy({
          captureErrors: true,
          captureLogs: false,
          captureHttpRequests: true,
          // captureMetrics is a legacy no-op — silently ignored
        }),
      ),
      defaultServiceName: 'svc',
      defaultServiceId: '11111111-1111-4111-8111-111111111111',
      defaultEnvironment: 'prod',
    });
    const base: SdkSpanRow = {
      span_timestamp: 't',
      trace_id: 'a'.repeat(32),
      span_id: '33333333-3333-4333-a333-333333333333',
      tenant_id: '22222222-2222-4222-a222-222222222222',
      project_id: '11111111-1111-4111-a111-111111111111',
      start_time: 't',
      end_time: 't',
      duration_ms: 1,
      is_error: false,
    };
    expect(g.shouldCaptureSpan({ ...base, span_type: 'http' })).toBe(true);
    expect(g.shouldCaptureSpan({ ...base, span_type: 'db' })).toBe(false);
  });

  it('allows errored spans even when http and span defaults are disabled', () => {
    const g = new CaptureGate({
      cache: mockCache(
        parseAndCompileCapturePolicy({
          enabled: true,
          defaultCapture: { error: true, http: false, log: false, span: false },
        }),
      ),
      defaultServiceName: 'svc',
      defaultServiceId: '11111111-1111-4111-8111-111111111111',
      defaultEnvironment: 'prod',
    });
    const base = {
      span_timestamp: 't',
      trace_id: 'trace',
      span_id: 'span',
      service_name: 'svc',
      environment: 'prod',
      span_name: 'GET /boom',
      start_time: 't',
      end_time: 't',
      duration_ms: 1,
    };
    expect(g.shouldCaptureSpan({ ...base, span_type: 'http', http_status_code: 500, is_error: true })).toBe(true);
  });
});

/**
 * Outbound (external) client spans go through the same capture gate before delivery. These lock in the
 * distributed-tracing invariant: an `external` span is classified as the `span` capture type (NOT `http`),
 * so a permissive policy keeps it (the cross-service edge survives) and a restrictive one drops it — while
 * an errored / 5xx outbound span is always kept (critical bypass), so failures never vanish from a trace.
 */
describe('CaptureGate — outbound (external) spans', () => {
  function gate(compiled: CompiledCapturePolicy): CaptureGate {
    return new CaptureGate({
      cache: mockCache(compiled),
      defaultServiceName: 'svc',
      defaultServiceId: '11111111-1111-4111-8111-111111111111',
      defaultEnvironment: 'prod',
    });
  }

  const external: SdkSpanRow = {
    span_timestamp: 't',
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
    service_name: 'svc',
    environment: 'prod',
    span_name: 'http.client POST downstream',
    span_type: 'external',
    start_time: 't',
    end_time: 't',
    duration_us: 22_000,
    status: 'ok',
  };

  it('captures the outbound span when the policy allows span capture', () => {
    const g = gate(
      parseAndCompileCapturePolicy({
        enabled: true,
        defaultCapture: { error: true, http: true, log: true, span: true },
      }),
    );
    expect(g.shouldCaptureSpan(external)).toBe(true);
  });

  it('drops the outbound span when span capture is disabled — even if http capture is on (external → span, not http)', () => {
    const g = gate(
      parseAndCompileCapturePolicy({
        enabled: true,
        defaultCapture: { error: true, http: true, log: true, span: false },
      }),
    );
    expect(g.shouldCaptureSpan(external)).toBe(false);
  });

  it('keeps an errored outbound span even when span capture is disabled (critical bypass)', () => {
    const g = gate(
      parseAndCompileCapturePolicy({
        enabled: true,
        defaultCapture: { error: true, http: false, log: false, span: false },
      }),
    );
    expect(
      g.shouldCaptureSpan({ ...external, status: 'error', error_type: 'HttpError', error_message: 'HTTP 503' }),
    ).toBe(true);
  });

  it('keeps a 5xx outbound span even when span capture is disabled (critical bypass)', () => {
    const g = gate(
      parseAndCompileCapturePolicy({
        enabled: true,
        defaultCapture: { error: true, http: false, log: false, span: false },
      }),
    );
    expect(g.shouldCaptureSpan({ ...external, http_status_code: 503 })).toBe(true);
  });
});
