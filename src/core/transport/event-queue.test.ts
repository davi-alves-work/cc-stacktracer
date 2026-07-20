import { describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../stacktrace-event.types.js';
import { SCHEMA_VERSION } from '../stacktrace-event.types.js';
import { EventQueue } from './event-queue.js';
import { IngestTransportError } from './ingest-transport-error.js';

function logEvent(message: string): LogEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'log',
    service: { name: 's', version: '1', environment: 'e' },
    environment: 'e',
    timestamp: new Date().toISOString(),
    message,
  };
}

describe('EventQueue', () => {
  it('backs off retryable delivery failures and retries after the delay', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi
        .fn()
        .mockRejectedValueOnce(
          new IngestTransportError({
            status: 429,
            code: 'INGEST_QUOTA_EXCEEDED',
            retryAfterMs: 2_000,
          }),
        )
        .mockResolvedValueOnce(undefined);
      const q = new EventQueue({
        sendMode: 'batch',
        maxBatchSize: 1,
        flushIntervalMs: 60_000,
        deliver,
        retryBackoff: { random: () => 0.5 },
      });

      q.enqueue(logEvent('retry later'));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      await q.flushPending();
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops permanently rejected chunks instead of retrying them forever', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        new IngestTransportError({
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
        }),
      )
      .mockResolvedValueOnce(undefined);
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('drop'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    q.enqueue(logEvent('next'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ message: 'next' })]);

    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(2);

    q.stop();
  });

  it('flushes when batch is full then drains remainder on flushPending', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = new EventQueue({
      sendMode: 'batch',
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('a'));
    q.enqueue(logEvent('b'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(deliver.mock.calls[0]?.[0]).toHaveLength(2);

    q.enqueue(logEvent('c'));
    expect(deliver).toHaveBeenCalledTimes(1);

    await q.flushPending();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toHaveLength(1);

    q.stop();
  });

  it('immediate mode delivers each event without batching', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const q = new EventQueue({
      sendMode: 'immediate',
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      deliver,
    });

    q.enqueue(logEvent('one'));
    q.enqueue(logEvent('two'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ message: 'one' })]);
    expect(deliver.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ message: 'two' })]);

    q.stop();
  });
});
