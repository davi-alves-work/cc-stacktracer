export type QueueRetryBackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMaxMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

const DEFAULT_RETRY_BACKOFF = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  retryAfterMaxMs: 300_000,
  jitterRatio: 0.2,
};

export function resetQueueRetryTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) {
    clearTimeout(timer);
  }
  return null;
}

export function nextQueueRetryDelayMs(params: {
  err: unknown;
  consecutiveFailures: number;
  options?: QueueRetryBackoffOptions;
}): number {
  const cfg = { ...DEFAULT_RETRY_BACKOFF, ...(params.options ?? {}) };
  const retryAfterMs = retryAfterMsFromError(params.err);
  const baseDelay =
    retryAfterMs !== undefined
      ? Math.min(cfg.retryAfterMaxMs, retryAfterMs)
      : Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** Math.max(0, params.consecutiveFailures - 1));
  const random = params.options?.random ?? Math.random;
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const factor = 1 - cfg.jitterRatio + boundedRandom * cfg.jitterRatio * 2;
  return Math.max(1, Math.round(baseDelay * factor));
}

function retryAfterMsFromError(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'retryAfterMs' in err &&
    typeof (err as { retryAfterMs?: unknown }).retryAfterMs === 'number'
  ) {
    const retryAfterMs = (err as { retryAfterMs: number }).retryAfterMs;
    return Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : undefined;
  }
  return undefined;
}
