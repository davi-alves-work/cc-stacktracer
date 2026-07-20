import { randomBytes } from 'node:crypto';
import { getStackTraceClient } from '../index.js';
import { runWithRequestContext, type HttpRequestSnapshot } from '../core/request-context.js';
import { runWithTraceContext } from '../core/trace-span-context.js';
import { normalizeHttpRouteForSpan } from '../shared/schema/index.js';
import { extractCorrelationFromHeaders } from '../utils/correlation.js';
import { headersToRecord } from '../utils/headers.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { redactUrl } from '../utils/redact-url.js';

export type StackTraceHttpRequestInput = {
  method: string;
  url: string;
  route?: string;
  headers?: Record<string, string | string[] | undefined>;
  startTime?: number;
  requestId?: string;
  traceparent?: string;
};

export type StackTraceHttpResponseInput = {
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
  error?: Error;
};

export type StackTraceHttpRequestSnapshot = {
  method: string;
  url: string;
  route: string;
  headers: Record<string, string>;
};

function pathOnly(url: string): string {
  return url.split('?')[0] ?? url;
}

function headersWithOverrides(input: StackTraceHttpRequestInput): Record<string, string | string[] | undefined> {
  return {
    ...(input.headers ?? {}),
    ...(input.requestId !== undefined ? { 'x-request-id': input.requestId } : {}),
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
  };
}

export class StackTraceHttpRequest {
  readonly traceId: string;
  readonly rootSpanId: string;
  /** Remote parent span id adopted from an inbound `traceparent`, if present. */
  readonly remoteParentSpanId?: string;
  /** W3C trace flags adopted from an inbound `traceparent`, if present. */
  readonly traceFlags?: string;
  readonly request: StackTraceHttpRequestSnapshot;

  private readonly startTime: number;
  private readonly snapshot: HttpRequestSnapshot;
  private ended = false;

  private constructor(params: {
    traceId: string;
    rootSpanId: string;
    remoteParentSpanId?: string;
    traceFlags?: string;
    startTime: number;
    request: StackTraceHttpRequestSnapshot;
    snapshot: HttpRequestSnapshot;
  }) {
    this.traceId = params.traceId;
    this.rootSpanId = params.rootSpanId;
    if (params.remoteParentSpanId !== undefined) {
      this.remoteParentSpanId = params.remoteParentSpanId;
    }
    if (params.traceFlags !== undefined) {
      this.traceFlags = params.traceFlags;
    }
    this.startTime = params.startTime;
    this.request = params.request;
    this.snapshot = params.snapshot;
  }

  static start(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
    const client = getStackTraceClient();
    const rawHeaders = headersToRecord(headersWithOverrides(input));
    const correlation = extractCorrelationFromHeaders(rawHeaders);
    // W3C trace context: adopt an incoming trace id when present, else generate 16-byte hex.
    const traceId = correlation.traceId ?? randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    const headers = redactHeaders(rawHeaders, {
      maxValueLength: 512,
      ...client?.getHeaderRedactionOptions(),
    });
    const url = redactUrl(input.url, client?.getUrlRedactionOptions());
    const route = input.route !== undefined && input.route.trim() !== '' ? input.route : pathOnly(url);
    const snapshot: HttpRequestSnapshot = {
      method: input.method,
      url,
      headers,
    };

    return new StackTraceHttpRequest({
      traceId,
      rootSpanId,
      ...(correlation.parentSpanId !== undefined ? { remoteParentSpanId: correlation.parentSpanId } : {}),
      ...(correlation.traceFlags !== undefined ? { traceFlags: correlation.traceFlags } : {}),
      startTime: input.startTime ?? Date.now(),
      request: {
        method: input.method,
        url,
        route,
        headers,
      },
      snapshot,
    });
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return runWithRequestContext(this.snapshot, () =>
      runWithTraceContext(this.traceId, this.rootSpanId, () => fn(), this.remoteParentSpanId, this.traceFlags),
    );
  }

  end(response: StackTraceHttpResponseInput): void {
    if (this.ended) return;
    this.ended = true;
    this.snapshot.statusCode = response.statusCode;

    const client = getStackTraceClient();
    if (!client) return;

    if (
      !client.shouldCaptureHttpRequest({
        endpoint: this.request.route,
        status_code: response.statusCode,
      })
    ) {
      return;
    }

    const endMs = Date.now();
    const durationMs = Math.max(0, endMs - this.startTime);
    const startIso = new Date(this.startTime).toISOString();
    const endIso = new Date(endMs).toISOString();

    const httpRoute = normalizeHttpRouteForSpan(this.request.method, this.request.route) ?? this.request.route;
    client.enqueueSpan({
      span_timestamp: endIso,
      trace_id: this.traceId,
      span_id: this.rootSpanId,
      parent_span_id: this.remoteParentSpanId ?? null,
      service_name: client.getServiceDescriptor().name,
      service_version: client.getServiceDescriptor().version,
      environment: client.getEnvironment(),
      span_name: `${this.request.method} ${this.request.route}`.slice(0, 1024),
      span_type: 'http',
      start_time: startIso,
      end_time: endIso,
      duration_us: Math.max(0, Math.round(durationMs * 1000)),
      status: response.statusCode >= 500 || response.error !== undefined ? 'error' : 'ok',
      http_method: this.request.method,
      http_route: httpRoute.slice(0, 4096),
      http_status_code: response.statusCode,
      error_type: response.error?.name ?? null,
      error_message: response.error !== undefined ? response.error.message.slice(0, 16_000) : null,
    });
  }
}

export function startHttpRequest(input: StackTraceHttpRequestInput): StackTraceHttpRequest {
  return StackTraceHttpRequest.start(input);
}

export function runWithHttpContext<T>(trace: StackTraceHttpRequest, fn: () => Promise<T> | T): Promise<T> {
  return trace.run(fn);
}

export function endHttpRequest(trace: StackTraceHttpRequest, response: StackTraceHttpResponseInput): void {
  trace.end(response);
}
