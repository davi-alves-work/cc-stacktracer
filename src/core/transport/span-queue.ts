import type { SdkSpanRow } from '../span-payload.types.js';
import { chunkBatches } from './batch-sender.js';
import { isPermanentIngestError } from './ingest-transport-error.js';
import { nextQueueRetryDelayMs, resetQueueRetryTimer, type QueueRetryBackoffOptions } from './queue-retry-backoff.js';

export type SpanQueueSendMode = 'batch' | 'immediate';

export type SpanQueueOptions = {
  sendMode: SpanQueueSendMode;
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize?: number;
  deliver: (batch: SdkSpanRow[]) => Promise<void>;
  onMetric?: (metric: SpanQueueMetric) => void;
  logger?: SpanQueueLogger;
  retryBackoff?: QueueRetryBackoffOptions;
};

export type SpanQueueMetricName =
  | 'spanqueue_flush_total'
  | 'spanqueue_flush_concurrent_total'
  | 'spanqueue_rerun_requested_total'
  | 'spanqueue_pending_items'
  | 'spanqueue_shutdown_flush_total'
  | 'spanqueue_flush_failure_total';

export type SpanQueueMetric = {
  name: SpanQueueMetricName;
  value: number;
  flushId?: number;
  queueSize: number;
};

export type SpanQueueLogger = {
  debug?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * In-memory buffer for span rows; same flush semantics as {@link EventQueue}.
 * Items are committed only after successful delivery; concurrent flushes are
 * coordinated through an active flush promise. Enqueues that arrive while a
 * flush is active request a rerun, so full batches are not stranded until the
 * next timer tick or shutdown drain.
 */
export class SpanQueue {
  private readonly queue: SdkSpanRow[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;
  private rerunRequested = false;
  private drainAllRequested = false;
  private flushSequence = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryNotBefore = 0;
  private consecutiveFailures = 0;

  constructor(private readonly options: SpanQueueOptions) {}

  enqueue(row: SdkSpanRow): void {
    if (this.options.sendMode === 'immediate') {
      void this.options.deliver([row]).catch(() => undefined);
      return;
    }

    if (this.options.maxQueueSize !== undefined && this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
    }

    this.queue.push(row);
    this.emitPendingMetric();
    this.ensureInterval();
    void this.runFlush(false);
  }

  async flushPending(): Promise<void> {
    if (this.options.sendMode === 'immediate') {
      return;
    }
    this.emitMetric('spanqueue_shutdown_flush_total', 1);
    await this.runFlush(true);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
  }

  private ensureInterval(): void {
    if (this.options.sendMode !== 'batch') {
      return;
    }
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.runFlush(true);
    }, this.options.flushIntervalMs);
    this.intervalHandle.unref();
  }

  private async runFlush(drainAll: boolean): Promise<void> {
    if (this.activeFlush !== null) {
      this.rerunRequested = true;
      this.drainAllRequested = this.drainAllRequested || drainAll;
      this.emitMetric('spanqueue_flush_concurrent_total', 1);
      this.emitMetric('spanqueue_rerun_requested_total', 1);
      this.options.logger?.debug?.(
        {
          flush_id: this.flushSequence,
          queue_size: this.queue.length,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: this.drainAllRequested,
          shutdown_phase: drainAll,
        },
        'spanqueue_flush_rerun_requested',
      );
      await this.activeFlush;
      return;
    }

    const flushId = ++this.flushSequence;
    const flush = this.runFlushLoop(drainAll, flushId);
    this.activeFlush = flush;
    try {
      await flush;
    } finally {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
    }
  }

  private async runFlushLoop(drainAll: boolean, flushId: number): Promise<void> {
    let currentDrainAll = drainAll;
    for (;;) {
      this.rerunRequested = false;
      this.emitMetric('spanqueue_flush_total', 1, flushId);
      this.options.logger?.debug?.(
        {
          flush_id: flushId,
          queue_size: this.queue.length,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: currentDrainAll,
          shutdown_phase: currentDrainAll,
        },
        'spanqueue_flush_started',
      );

      const limit = currentDrainAll ? this.queue.length : undefined;
      const delivered = await this.deliverQueued(limit, flushId);
      const shouldDrainAll = this.drainAllRequested;
      this.drainAllRequested = false;

      this.options.logger?.debug?.(
        {
          flush_id: flushId,
          queue_size: this.queue.length,
          delivered,
          active_flush: true,
          rerun_requested: this.rerunRequested,
          drain_all_requested: shouldDrainAll,
          shutdown_phase: currentDrainAll || shouldDrainAll,
        },
        'spanqueue_flush_completed',
      );

      if (!this.rerunRequested && !shouldDrainAll) {
        return;
      }
      if (delivered === 0 && !shouldDrainAll && this.queue.length < this.options.maxBatchSize) {
        return;
      }
      currentDrainAll = shouldDrainAll;
    }
  }

  private async deliverQueued(limit: number | undefined, flushId: number): Promise<number> {
    if (this.retryNotBefore > Date.now()) {
      return 0;
    }
    const count = limit ?? this.queue.length;
    if (count === 0) return 0;

    const minBatch = limit !== undefined ? 1 : this.options.maxBatchSize;
    const chunks = chunkBatches(this.queue.slice(0, count), this.options.maxBatchSize);

    let delivered = 0;
    for (const chunk of chunks) {
      if (chunk.length < minBatch) break;
      try {
        await this.options.deliver(chunk);
        this.resetBackoff();
        delivered += chunk.length;
      } catch (err) {
        this.emitMetric('spanqueue_flush_failure_total', 1, flushId);
        this.options.logger?.warn?.(
          {
            flush_id: flushId,
            queue_size: this.queue.length,
            active_flush: true,
            rerun_requested: this.rerunRequested,
            drain_all_requested: this.drainAllRequested,
            shutdown_phase: limit !== undefined,
          },
          'spanqueue_flush_failed',
        );
        if (isPermanentIngestError(err)) {
          delivered += chunk.length;
          continue;
        }
        this.scheduleRetry(err);
        break;
      }
    }

    if (delivered > 0) {
      this.queue.splice(0, delivered);
      this.emitPendingMetric(flushId);
    }
    return delivered;
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.retryNotBefore = 0;
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
  }

  private scheduleRetry(err: unknown): void {
    this.consecutiveFailures += 1;
    const delayMs = nextQueueRetryDelayMs({
      err,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.options.retryBackoff !== undefined ? { options: this.options.retryBackoff } : {}),
    });
    this.retryNotBefore = Date.now() + delayMs;
    this.retryTimer = resetQueueRetryTimer(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.runFlush(false);
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private emitPendingMetric(flushId?: number): void {
    this.emitMetric('spanqueue_pending_items', this.queue.length, flushId);
  }

  private emitMetric(name: SpanQueueMetricName, value: number, flushId?: number): void {
    this.options.onMetric?.({
      name,
      value,
      queueSize: this.queue.length,
      ...(flushId !== undefined ? { flushId } : {}),
    });
  }
}
