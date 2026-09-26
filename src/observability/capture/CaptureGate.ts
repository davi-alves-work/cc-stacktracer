import {
  evaluateCapture,
  samplingRandomForKey,
  spanRowToCaptureEventType,
  type CaptureEvaluationContext,
  type CaptureEventType,
  type CompiledCapturePolicy,
} from '../../shared/schema/index.js';
import type { SdkSpanRow } from '../../core/span-payload.types.js';
import type { StackTraceEvent } from '../../core/stacktrace-event.types.js';
import type { CapturePolicyCache } from './CapturePolicyCache.js';
import type { CaptureContext } from './types.js';
import { buildCapturePolicyKey, buildCapturePolicyServiceIdKey } from './policy-key.js';
import { decideStackTraceCapture } from './decide-stacktrace-capture.js';

export type CaptureGateOptions = {
  cache: CapturePolicyCache;
  defaultServiceId: string;
  defaultServiceName: string;
  defaultEnvironment: string;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
};

function toEvaluationContext(
  ctx: CaptureContext,
  defaults: { service_name: string; environment: string },
): CaptureEvaluationContext {
  return {
    service_name: ctx.service_name ?? defaults.service_name,
    ...(ctx.endpoint !== undefined ? { endpoint: ctx.endpoint } : {}),
    ...(ctx.status_code !== undefined ? { status_code: ctx.status_code } : {}),
    ...(ctx.critical !== undefined ? { critical: ctx.critical } : {}),
  };
}

/**
 * Synchronous capture decisions for the hot path (no I/O). Policy is read from {@link CapturePolicyCache}.
 */
export class CaptureGate {
  private readonly rng: () => number;

  constructor(private readonly opts: CaptureGateOptions) {
    this.rng = opts.random ?? Math.random;
  }

  /**
   * Sorte derivada da chave (trace/evento), a mesma que o servidor usa — ver `samplingValueForKey`. Um
   * `random` injetado (testes) continua valendo; sem chave, cai no aleatorio.
   */
  private rngFor(key: string | null | undefined): () => number {
    if (this.opts.random !== undefined) return this.opts.random;
    return samplingRandomForKey(key) ?? this.rng;
  }

  shouldCapture(eventType: CaptureEventType, context: CaptureContext = {}): boolean {
    const key = buildCapturePolicyKey(
      context.service_name ?? this.opts.defaultServiceName,
      context.environment ?? this.opts.defaultEnvironment,
    );
    const compiled =
      this.opts.cache.getPolicy(buildCapturePolicyServiceIdKey(this.opts.defaultServiceId)) ??
      this.opts.cache.getPolicy(key);
    return evaluateCapture(
      compiled,
      eventType,
      toEvaluationContext(context, {
        service_name: this.opts.defaultServiceName,
        environment: this.opts.defaultEnvironment,
      }),
      { random: this.rng },
    );
  }

  shouldCaptureWithPolicy(
    eventType: CaptureEventType,
    context: CaptureContext,
    compiled: CompiledCapturePolicy,
  ): boolean {
    return evaluateCapture(
      compiled,
      eventType,
      toEvaluationContext(context, {
        service_name: this.opts.defaultServiceName,
        environment: this.opts.defaultEnvironment,
      }),
      { random: this.rng },
    );
  }

  /**
   * HTTP spans use event type `http`; other spans use `span` for rule / default resolution
   * (legacy: http → captureHttpRequests, others → captureLogs via compiled defaults).
   */
  shouldCaptureSpan(row: SdkSpanRow): boolean {
    const key = buildCapturePolicyKey(
      row.service_name ?? this.opts.defaultServiceName,
      row.environment ?? this.opts.defaultEnvironment,
    );
    const compiled =
      this.opts.cache.getPolicy(
        row.service_id !== undefined && row.service_id !== null
          ? buildCapturePolicyServiceIdKey(row.service_id)
          : buildCapturePolicyServiceIdKey(this.opts.defaultServiceId),
      ) ?? this.opts.cache.getPolicy(key);
    const eventType = spanRowToCaptureEventType(row.span_type);
    const critical =
      row.status === 'error' ||
      (row.http_status_code !== undefined && row.http_status_code !== null && row.http_status_code >= 500);
    return evaluateCapture(
      compiled,
      eventType,
      {
        service_name: row.service_name ?? this.opts.defaultServiceName,
        ...(row.http_route !== undefined && row.http_route !== null && row.http_route !== ''
          ? { endpoint: row.http_route }
          : {}),
        ...(row.http_status_code !== undefined && row.http_status_code !== null
          ? { status_code: row.http_status_code }
          : {}),
        ...(critical ? { critical: true } : {}),
        // Sem isto, regra com `minDurationMs` nunca casava no SDK.
        duration_ms: Math.round(row.duration_us / 1000),
      },
      { random: this.rngFor(row.trace_id) },
    );
  }

  shouldCaptureStackTraceEvent(event: StackTraceEvent): boolean {
    const key = buildCapturePolicyServiceIdKey(this.opts.defaultServiceId);
    const compiled = this.opts.cache.getPolicy(key);
    const trace = event.context?.trace as { trace_id?: unknown } | undefined;
    const traceId = typeof trace?.trace_id === 'string' ? trace.trace_id : undefined;
    return decideStackTraceCapture(event, compiled, this.rngFor(traceId ?? event.eventId));
  }
}
