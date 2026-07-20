import type { StackTraceEvent } from '../stacktrace-event.types.js';

/**
 * Splits items into consecutive batches of at most `maxBatchSize`.
 */
export function chunkBatches<T>(items: readonly T[], maxBatchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxBatchSize) {
    chunks.push(items.slice(i, i + maxBatchSize));
  }
  return chunks;
}

/** @deprecated Use {@link chunkBatches} */
export function chunkEvents(events: readonly StackTraceEvent[], maxBatchSize: number): StackTraceEvent[][] {
  return chunkBatches(events, maxBatchSize);
}

/**
 * Delivers each chunk sequentially through `deliver`.
 */
export async function deliverBatches<T>(
  items: readonly T[],
  maxBatchSize: number,
  deliver: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (const batch of chunkBatches(items, maxBatchSize)) {
    await deliver(batch);
  }
}
