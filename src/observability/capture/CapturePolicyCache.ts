import {
  DEFAULT_COMPILED_CAPTURE_POLICY,
  parseAndCompileCapturePolicy,
  type CompiledCapturePolicy,
} from '../../shared/schema/index.js';
import { buildCapturePolicyServiceIdKey } from './policy-key.js';

export type CapturePolicyCacheOptions = {
  apiKey: string;
  /** Ingestion base URL (same as `init.endpoint`). */
  endpoint: string;
  serviceId: string;
  /** Full URL override; otherwise `${endpoint}/ingest/capture-policy?...`. */
  capturePolicyUrl?: string | undefined;
  refreshMs: number;
  getHeaders?: (() => Record<string, string>) | undefined;
  onFetchError?: ((err: unknown) => void) | undefined;
  /** Test hook; defaults to Math.random. */
  random?: (() => number) | undefined;
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 300_000;
const RETRY_AFTER_MAX_MS = 3_600_000;
const JITTER_RATIO = 0.1;

function buildDefaultUrl(endpoint: string, serviceId: string): string {
  const base = endpoint.replace(/\/$/, '');
  const q = new URLSearchParams({ serviceId });
  return `${base}/ingest/capture-policy?${q.toString()}`;
}

/**
 * In-memory capture policy with periodic HTTP refresh. Hot-path readers call {@link getPolicy}
 * synchronously; refresh swaps the compiled policy map reference.
 *
 * On first-fetch failure a fast retry fires after {@link FIRST_FETCH_RETRY_MS} so a transient
 * startup error (endpoint not yet ready) does not leave the cache stale for a full `refreshMs`.
 */
export class CapturePolicyCache {
  private readonly policyKey: string;
  private policies: ReadonlyMap<string, CompiledCapturePolicy>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight = false;
  private failureCount = 0;

  constructor(private readonly opts: CapturePolicyCacheOptions) {
    this.policyKey = buildCapturePolicyServiceIdKey(opts.serviceId);
    this.policies = new Map([[this.policyKey, DEFAULT_COMPILED_CAPTURE_POLICY]]);
  }

  /** Synchronous read of the current compiled policy for this client's service id. */
  getPolicy(_key?: string): CompiledCapturePolicy {
    const key = _key ?? this.policyKey;
    return this.policies.get(key) ?? DEFAULT_COMPILED_CAPTURE_POLICY;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.fetchOnce();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopped = true;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped || this.opts.refreshMs <= 0) {
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetchOnce();
    }, delayMs);
    this.timer.unref?.();
  }

  private jitter(delayMs: number): number {
    const random = this.opts.random ?? Math.random;
    const boundedRandom = Math.min(1, Math.max(0, random()));
    const factor = 1 - JITTER_RATIO + boundedRandom * JITTER_RATIO * 2;
    return Math.max(1, Math.round(delayMs * factor));
  }

  private backoffDelay(): number {
    this.failureCount += 1;
    const exponential = this.opts.refreshMs * 2 ** Math.min(this.failureCount, 10);
    return this.jitter(Math.min(MAX_BACKOFF_MS, exponential));
  }

  private retryAfterDelay(res: Response): number | null {
    const raw = res.headers.get('retry-after');
    if (raw === null) {
      return null;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(RETRY_AFTER_MAX_MS, Math.round(seconds * 1000));
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, dateMs - Date.now()));
    }
    return null;
  }

  private async fetchOnce(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    let nextDelayMs: number | undefined;
    const url = this.opts.capturePolicyUrl ?? buildDefaultUrl(this.opts.endpoint, this.opts.serviceId);
    const headers: Record<string, string> = {
      'x-api-key': this.opts.apiKey,
      ...(this.opts.getHeaders?.() ?? {}),
    };
    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const res = await fetch(url, { method: 'GET', headers, signal });
      if (!res.ok) {
        this.opts.onFetchError?.(new Error(`capture-policy HTTP ${res.status}`));
        nextDelayMs = res.status === 429 ? (this.retryAfterDelay(res) ?? this.backoffDelay()) : this.backoffDelay();
        return;
      }
      const json: unknown = await res.json();
      const data =
        typeof json === 'object' &&
        json !== null &&
        'data' in json &&
        typeof (json as { data: unknown }).data === 'object' &&
        (json as { data: { capturePolicy?: unknown } }).data !== null
          ? (json as { data: { capturePolicy?: unknown } }).data
          : undefined;
      const raw = data?.capturePolicy;
      const policy = parseAndCompileCapturePolicy(raw);
      this.policies = new Map([[this.policyKey, policy]]);
      this.failureCount = 0;
      nextDelayMs = this.jitter(this.opts.refreshMs);
    } catch (err) {
      this.opts.onFetchError?.(err);
      nextDelayMs = this.backoffDelay();
    } finally {
      this.inFlight = false;
      if (nextDelayMs !== undefined) {
        this.scheduleNext(nextDelayMs);
      }
    }
  }
}
