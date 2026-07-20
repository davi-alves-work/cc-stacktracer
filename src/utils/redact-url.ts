const DEFAULT_SENSITIVE_QUERY_KEYS = new Set(
  [
    'code',
    'token',
    'access_token',
    'refresh_token',
    'id_token',
    'api_key',
    'apikey',
    'key',
    'secret',
    'signature',
    'sig',
    'password',
    'pass',
    'auth',
    'authorization',
    'session',
    'session_id',
    'sid',
    'jwt',
  ].map((key) => key.toLowerCase()),
);

const REDACTED = '[REDACTED]';
const FALLBACK_BASE_URL = 'http://cc-stacktracer.local';

export type RedactUrlOptions = {
  extraSensitiveQueryKeys?: readonly string[];
};

function sensitiveQueryKeys(options?: RedactUrlOptions): Set<string> {
  const sensitive = new Set(DEFAULT_SENSITIVE_QUERY_KEYS);
  for (const key of options?.extraSensitiveQueryKeys ?? []) {
    sensitive.add(key.toLowerCase());
  }
  return sensitive;
}

export function redactUrl(url: string, options?: RedactUrlOptions): string {
  try {
    const parsed = new URL(url, FALLBACK_BASE_URL);
    const sensitive = sensitiveQueryKeys(options);
    const redactedParams = new URLSearchParams();

    for (const [key, value] of parsed.searchParams.entries()) {
      redactedParams.append(key, sensitive.has(key.toLowerCase()) ? REDACTED : value);
    }

    const query = redactedParams.toString();
    return `${parsed.pathname}${query === '' ? '' : `?${query}`}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
