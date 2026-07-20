export type IngestTransportErrorInput = {
  status?: number | undefined;
  code?: string | undefined;
  retryAfterMs?: number | undefined;
  message?: string | undefined;
  cause?: unknown;
};

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 413, 415]);

export class IngestTransportError extends Error {
  override readonly name = 'IngestTransportError';
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly retryable: boolean;
  readonly permanent: boolean;

  constructor(input: IngestTransportErrorInput = {}) {
    super(input.message ?? ingestTransportErrorMessage(input), { cause: input.cause });
    this.status = input.status;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs;
    this.retryable = isRetryableStatus(input.status);
    this.permanent = isPermanentStatus(input.status);
  }
}

export function isRetryableIngestError(err: unknown): boolean {
  return err instanceof IngestTransportError ? err.retryable : true;
}

export function isPermanentIngestError(err: unknown): boolean {
  return err instanceof IngestTransportError ? err.permanent : false;
}

function ingestTransportErrorMessage(input: IngestTransportErrorInput): string {
  if (input.status !== undefined) {
    return `ingest failed with status ${input.status}`;
  }
  return 'ingest transport failed';
}

function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

function isPermanentStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  return PERMANENT_STATUS_CODES.has(status) || (status >= 400 && status < 500 && !isRetryableStatus(status));
}
