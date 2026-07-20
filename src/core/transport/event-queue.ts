import type { StackTraceEvent } from '../stacktrace-event.types.js';
import { chunkBatches } from './batch-sender.js';
import { isPermanentIngestError } from './ingest-transport-error.js';
import { nextQueueRetryDelayMs, resetQueueRetryTimer, type QueueRetryBackoffOptions } from './queue-retry-backoff.js';

export type EventQueueSendMode = 'batch' | 'immediate';

export type EventQueueOptions = {
  sendMode: EventQueueSendMode;
  maxBatchSize: number;
  flushIntervalMs: number;
  maxQueueSize?: number;
  deliver: (batch: StackTraceEvent[]) => Promise<void>;
  retryBackoff?: QueueRetryBackoffOptions;
};

/**
 * In-memory queue: flushes full batches on enqueue, on interval, and via {@link flushPending}.
 * In `immediate` mode, each event is delivered in its own batch without queueing.
 *
 * Reliability guarantees:
 * - Items are only removed from the queue after a successful delivery. A failed
 *   delivery leaves items in place so the next flush cycle retries them.
 * - An `isFlushing` guard prevents concurrent flush operations from interleaving
 *   and issuing duplicate HTTP requests during traffic bursts.
 */
export class EventQueue {
  private readonly queue: StackTraceEvent[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;
  private rerunRequested = false;
  private drainAllRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryNotBefore = 0;
  private consecutiveFailures = 0;

  constructor(private readonly options: EventQueueOptions) {}

  enqueue(event: StackTraceEvent): void {
    if (this.options.sendMode === 'immediate') {
      void this.options.deliver([event]).catch(() => undefined);
      return;
    }

    if (this.options.maxQueueSize !== undefined && this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
    }

    this.queue.push(event);
    this.ensureInterval();
    void this.runFlush(false);
  }

  /**
   * Flushes all pending events in order, in chunks of `maxBatchSize`.
   * Items are committed (removed) only after successful delivery.
   */
  async flushPending(): Promise<void> {
    if (this.options.sendMode === 'immediate') {
      return;
    }
    await this.runFlush(true);
  }

  /**
   * Stops the periodic flush timer. Does not flush pending events.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.retryTimer !== null) {
      this.retryTimer = resetQueueRetryTimer(this.retryTimer);
    }
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

  /**
   * Core flush routine shared by interval, enqueue, and flushPending.
   * @param drainAll — true = flush everything; false = only flush full batches.
   */
  private async runFlush(drainAll: boolean): Promise<void> {
    if (this.activeFlush !== null) {
      this.rerunRequested = true;
      this.drainAllRequested = this.drainAllRequested || drainAll;
      await this.activeFlush;
      return;
    }

    const flush = this.runFlushLoop(drainAll);
    this.activeFlush = flush;
    try {
      await flush;
    } finally {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
    }
  }

  private async runFlushLoop(drainAll: boolean): Promise<void> {
    let currentDrainAll = drainAll;
    for (;;) {
      this.rerunRequested = false;
      const limit = currentDrainAll ? this.queue.length : undefined;
      const delivered = await this.deliverQueued(limit);
      const shouldDrainAll = this.drainAllRequested;
      this.drainAllRequested = false;

      if (!this.rerunRequested && !shouldDrainAll) {
        return;
      }
      if (delivered === 0 && !shouldDrainAll && this.queue.length < this.options.maxBatchSize) {
        return;
      }
      currentDrainAll = shouldDrainAll;
    }
  }

  /**
   * Delivers queued items chunk by chunk. Commits (splices) only the items that
   * were successfully delivered; stops on the first failure so undelivered items
   * remain in the queue for the next flush attempt.
   */
  private async deliverQueued(limit: number | undefined): Promise<number> {
    if (this.retryNotBefore > Date.now()) {
      return 0;
    }
    const count = limit ?? this.queue.length;
    if (count === 0) return 0;

    const minBatch = limit !== undefined ? 1 : this.options.maxBatchSize;
    const chunks = chunkBatches(this.queue.slice(0, count), this.options.maxBatchSize);

    let delivered = 0;
    for (const chunk of chunks) {
      if (chunk.length < minBatch) break; // only deliver full batches when not draining
      try {
        await this.options.deliver(chunk);
        this.resetBackoff();
        delivered += chunk.length;
      } catch (err) {
        if (isPermanentIngestError(err)) {
          delivered += chunk.length;
          continue;
        }
        this.scheduleRetry(err);
        break; // leave remaining items in queue for next flush
      }
    }

    if (delivered > 0) {
      this.queue.splice(0, delivered);
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
}
