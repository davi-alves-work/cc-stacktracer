import type { CompiledCapturePolicy } from '../shared/schema/index.js';
import { CapturePolicyCache, type CapturePolicyCacheOptions } from '../observability/capture/CapturePolicyCache.js';

export type CapturePolicyRuntimeOptions = CapturePolicyCacheOptions;

/**
 * @deprecated Prefer {@link CapturePolicyCache} + {@link CaptureGate}; this class remains as a thin adapter.
 * Polls remote capture policy; {@link get} returns last known policy (defaults all true until first success).
 */
export class CapturePolicyRuntime {
  private readonly cache: CapturePolicyCache;

  constructor(opts: CapturePolicyRuntimeOptions) {
    this.cache = new CapturePolicyCache(opts);
  }

  get(): CompiledCapturePolicy {
    return this.cache.getPolicy();
  }

  start(): void {
    this.cache.start();
  }

  stop(): void {
    this.cache.stop();
  }
}
