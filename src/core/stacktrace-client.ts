import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { normalizeEventV4, type NormalizeOptions } from '../shared/schema/index.js';
import type { ParsedStackTraceInit } from './config.schema.js';
import { parseStackTraceInit } from './config.schema.js';
import { SDK_VERSION } from './sdk-version.js';
import { CaptureGate } from '../observability/capture/CaptureGate.js';
import { CapturePolicyCache } from '../observability/capture/CapturePolicyCache.js';
import { createRuntimeNoticeReporter } from '../observability/capture/runtime-notices.js';
import { getScopeContextForMerge } from './scope-metadata.js';
import type { ServiceDescriptor, StackTraceEvent } from './stacktrace-event.types.js';
import { toWirePayloadForIngest } from './wire-event.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { EventQueue } from './transport/event-queue.js';
import { SpanQueue } from './transport/span-queue.js';
import { sendWithFetch } from './transport/default-fetch-transport.js';
import { IngestTransportError } from './transport/ingest-transport-error.js';
import { signIngestionRequest } from './transport/ingestion-signing.js';

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_INGEST_PATH = '/v1/events';
const DEFAULT_SPANS_PATH = '/v1/spans';

/** Path da URL do POST, alinhado com `req.url` do Fastify na canónica do servidor (sem query). */
function ingestPathForSignature(fullUrl: string, fallback: string): string {
  try {
    const p = new URL(fullUrl).pathname;
    return p.length > 0 ? p : fallback;
  } catch {
    return fallback;
  }
}

function retryAfterHeaderToMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function responseErrorJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await response.clone().json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function ingestTransportErrorFromResponse(response: Response, message: string): Promise<IngestTransportError> {
  const body = await responseErrorJson(response);
  return new IngestTransportError({
    status: response.status,
    code: typeof body?.code === 'string' ? body.code : undefined,
    retryAfterMs: numberField(body?.retryAfterMs) ?? retryAfterHeaderToMs(response.headers.get('retry-after')),
    message,
  });
}

/** Payload passed to a custom `transport` for each delivered batch. */
export type BatchTransportPayload =
  | { kind: 'batch'; events: StackTraceEvent[] }
  | { kind: 'spans'; spans: SdkSpanRow[] };

export class StackTraceClient {
  private readonly queue: EventQueue;
  private readonly spanQueue: SpanQueue;
  private readonly config: ParsedStackTraceInit;
  private readonly serviceDescriptor: ServiceDescriptor;
  private readonly capturePolicyCache: CapturePolicyCache | null;
  private readonly captureGate: CaptureGate | null;

  constructor(config: ParsedStackTraceInit) {
    this.config = config;
    this.serviceDescriptor = {
      name: config.service,
      version: config.release ?? process.env.APP_VERSION ?? 'unknown',
      environment: config.environment,
    };
    const refreshMs = config.capturePolicyRefreshMs === undefined ? 0 : config.capturePolicyRefreshMs;
    if (refreshMs > 0) {
      this.capturePolicyCache = new CapturePolicyCache({
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        serviceId: config.serviceId,
        refreshMs,
        ...(config.capturePolicyUrl !== undefined ? { capturePolicyUrl: config.capturePolicyUrl } : {}),
        ...(config.getHeaders !== undefined ? { getHeaders: config.getHeaders } : {}),
        ...(config.onTransportError !== undefined ? { onFetchError: config.onTransportError } : {}),
        // O cache entrega os avisos; quem decide logar e deduplicar mora fora dele.
        onNotices: createRuntimeNoticeReporter({ suppress: config.suppressServerNotices === true }),
      });
      this.captureGate = new CaptureGate({
        cache: this.capturePolicyCache,
        defaultServiceId: config.serviceId,
        defaultServiceName: config.service,
        defaultEnvironment: config.environment,
      });
      this.capturePolicyCache.start();
    } else {
      this.capturePolicyCache = null;
      this.captureGate = null;
    }
    this.queue = new EventQueue({
      sendMode: config.sendMode,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      ...(config.maxQueueSize !== undefined ? { maxQueueSize: config.maxQueueSize } : {}),
      deliver: (batch) => this.deliverBatch(batch),
    });
    this.spanQueue = new SpanQueue({
      sendMode: config.sendMode,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      ...(config.maxQueueSize !== undefined ? { maxQueueSize: config.maxQueueSize } : {}),
      deliver: (batch) => this.deliverSpanBatch(batch),
    });
  }

  enqueueSpan(row: SdkSpanRow): void {
    if (this.config.enabled === false) {
      return;
    }
    if (this.captureGate !== null && !this.captureGate.shouldCaptureSpan(row)) {
      return;
    }
    this.spanQueue.enqueue(this.attachLegacySpanScope(row));
  }

  enqueue(event: StackTraceEvent): void {
    if (this.config.enabled === false) {
      return;
    }
    const next = this.config.beforeSend ? this.config.beforeSend(event) : event;
    if (next === null) {
      return;
    }
    if (this.captureGate !== null && !this.captureGate.shouldCaptureStackTraceEvent(next)) {
      return;
    }
    this.queue.enqueue(this.attachCommonContext(next));
  }

  /** Release string from `init({ release })`, if set. */
  getRelease(): string | undefined {
    return this.config.release;
  }

  private attachCommonContext(event: StackTraceEvent): StackTraceEvent {
    const existingResource =
      typeof event.context?.resource === 'object' && event.context?.resource !== null
        ? (event.context.resource as Record<string, unknown>)
        : {};
    const resource: Record<string, unknown> = {
      ...existingResource,
      'host.name': hostname(),
      'process.pid': process.pid,
      'service.name': this.serviceDescriptor.name,
      'service.version': this.serviceDescriptor.version,
      'deployment.environment': this.config.environment,
      'telemetry.sdk.name': 'cc-stacktracer',
      'telemetry.sdk.version': SDK_VERSION,
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.version,
    };
    if (process.title !== undefined && process.title !== '') {
      resource['process.title'] = process.title.slice(0, 256);
    }

    const extra: Record<string, unknown> = {
      runtime: { node: process.version },
      resource,
    };
    if (this.config.release !== undefined) {
      extra.release = this.config.release;
    }
    const scope = getScopeContextForMerge();
    if (scope !== undefined) {
      Object.assign(extra, scope);
    }
    const merged = { ...extra, ...event.context };
    return { ...event, context: merged } as StackTraceEvent;
  }

  private attachLegacySpanScope(row: SdkSpanRow): SdkSpanRow {
    const scoped: SdkSpanRow = { ...row };
    if (scoped.tenant_id == null && this.config.tenantId !== undefined) {
      scoped.tenant_id = this.config.tenantId;
    }
    if (scoped.project_id == null && this.config.projectId !== undefined) {
      scoped.project_id = this.config.projectId;
    }
    if (scoped.service_id == null) {
      scoped.service_id = this.config.serviceId;
    }
    return scoped;
  }

  async flush(): Promise<void> {
    await this.queue.flushPending();
    await this.spanQueue.flushPending();
  }

  /**
   * Stops capture-policy refresh and batch flush timers without flushing queues.
   * Used when replacing the singleton client (e.g. hot reload) so the previous
   * client cannot keep posting after a new `init()`.
   */
  detachScheduling(): void {
    this.capturePolicyCache?.stop();
    this.queue.stop();
    this.spanQueue.stop();
  }

  /** When capture policy refresh is enabled, checks HTTP capture rules before building request telemetry. */
  shouldCaptureHttpRequest(ctx?: { endpoint?: string; status_code?: number }): boolean {
    if (this.captureGate === null) {
      return true;
    }
    const critical = ctx?.status_code !== undefined && ctx.status_code >= 500;
    return this.captureGate.shouldCapture('http', {
      ...(ctx?.endpoint !== undefined ? { endpoint: ctx.endpoint } : {}),
      ...(ctx?.status_code !== undefined ? { status_code: ctx.status_code } : {}),
      ...(critical ? { critical: true } : {}),
    });
  }

  getHeaderRedactionOptions(): { extraSensitiveKeys?: readonly string[] } {
    return {
      ...(this.config.headerRedaction?.extraSensitiveKeys !== undefined
        ? { extraSensitiveKeys: this.config.headerRedaction.extraSensitiveKeys }
        : {}),
    };
  }

  getUrlRedactionOptions(): { extraSensitiveQueryKeys?: readonly string[] } {
    return {
      ...(this.config.urlRedaction?.extraSensitiveQueryKeys !== undefined
        ? { extraSensitiveQueryKeys: this.config.urlRedaction.extraSensitiveQueryKeys }
        : {}),
    };
  }

  async shutdown(): Promise<void> {
    this.capturePolicyCache?.stop();
    this.queue.stop();
    this.spanQueue.stop();
    await this.flush();
  }

  getService(): string {
    return this.config.service;
  }

  /** Structured service identity for envelopes (`name`, `version`, `environment`). */
  getServiceDescriptor(): ServiceDescriptor {
    return this.serviceDescriptor;
  }

  getEnvironment(): string {
    return this.config.environment;
  }

  private async deliverBatch(batch: StackTraceEvent[]): Promise<void> {
    try {
      if (this.config.transport) {
        const payload: BatchTransportPayload = { kind: 'batch', events: batch };
        await this.config.transport(payload);
        return;
      }
      await this.sendDefaultIngest(batch);
    } catch (err: unknown) {
      this.config.onTransportError?.(err);
      // Re-throw so the queue knows delivery failed and keeps items for retry.
      throw err;
    }
  }

  private async deliverSpanBatch(batch: SdkSpanRow[]): Promise<void> {
    try {
      if (this.config.transport) {
        const payload: BatchTransportPayload = { kind: 'spans', spans: batch };
        await this.config.transport(payload);
        return;
      }
      await this.sendDefaultSpans(batch);
    } catch (err: unknown) {
      this.config.onTransportError?.(err);
      throw err;
    }
  }

  private warnDroppedContextKey(key: string): void {
    this.config.logger?.warn?.(
      { key },
      `cc-stacktracer: dropped context/attributes key "${key}" — its value is an object/array under ` +
        'an unrecognized top-level key and was not sent. Known blocks: http, db, business, correlation, ' +
        'queue, tags. See docs/client-installation-integration-playbook.md section 20.5.',
    );
  }

  private async sendDefaultIngest(batch: StackTraceEvent[]): Promise<void> {
    const base = this.config.endpoint.replace(/\/$/, '');
    const url = `${base}${DEFAULT_INGEST_PATH}`;
    const signPath = ingestPathForSignature(url, DEFAULT_INGEST_PATH);
    const wire = batch.map((e) => toWirePayloadForIngest(e));
    // W3C-hex (32) trace fallback so v4 events without an inbound traceparent still validate.
    const batchTraceFallback = randomBytes(16).toString('hex');
    const normalizeOpts: NormalizeOptions =
      this.config.tenantId !== undefined && this.config.projectId !== undefined
        ? {
            requestTraceFallback: batchTraceFallback,
            tenantId: this.config.tenantId,
            projectId: this.config.projectId,
            serviceId: this.config.serviceId,
          }
        : { requestTraceFallback: batchTraceFallback, serviceId: this.config.serviceId };
    if (this.config.logger?.warn !== undefined) {
      normalizeOpts.onDroppedContextKey = (key: string) => this.warnDroppedContextKey(key);
    }
    const canonical = wire.map((item) => normalizeEventV4(item, normalizeOpts));
    const body = JSON.stringify({ events: canonical });
    const headers: Record<string, string> = {
      ...(this.config.getHeaders?.() ?? {}),
      'x-api-key': this.config.apiKey,
      ...signIngestionRequest({
        apiKey: this.config.apiKey,
        method: 'POST',
        path: signPath,
        serializedBody: body,
      }),
    };
    const response = await sendWithFetch({ url, headers, body });
    if (!response.ok) {
      throw await ingestTransportErrorFromResponse(response, `ingest failed with status ${response.status}`);
    }
  }

  private async sendDefaultSpans(spans: SdkSpanRow[]): Promise<void> {
    const base = this.config.endpoint.replace(/\/$/, '');
    const url = `${base}${DEFAULT_SPANS_PATH}`;
    const signPath = ingestPathForSignature(url, DEFAULT_SPANS_PATH);
    const body = JSON.stringify({ spans });
    const headers: Record<string, string> = {
      ...(this.config.getHeaders?.() ?? {}),
      'x-api-key': this.config.apiKey,
      ...signIngestionRequest({
        apiKey: this.config.apiKey,
        method: 'POST',
        path: signPath,
        serializedBody: body,
      }),
    };
    const response = await sendWithFetch({ url, headers, body });
    if (!response.ok) {
      throw await ingestTransportErrorFromResponse(response, `span ingest failed with status ${response.status}`);
    }
  }
}

export function createStackTraceClient(input: unknown): StackTraceClient {
  return new StackTraceClient(parseStackTraceInit(input));
}
