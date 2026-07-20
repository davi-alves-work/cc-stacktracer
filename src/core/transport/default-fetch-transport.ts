export type SendWithFetchInput = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Request timeout in milliseconds (default 10_000). Uses `AbortSignal.timeout` when available. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Drops any `Content-Type` so caller `getHeaders()` cannot break JSON ingest (Fastify only registers `application/json`). */
function headersWithoutContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-type') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Sends a single POST with the given JSON body using global `fetch`.
 */
export async function sendWithFetch(input: SendWithFetchInput): Promise<Response> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = headersWithoutContentType(input.headers);
  return fetch(input.url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: input.body,
    signal,
  });
}
