import { getSdkRuntime } from '../../core/client-ref.js';
import type { OutboundClassification, OutboundHttpOptions } from './types.js';

function matchesAny(href: string, host: string, patterns: Array<string | RegExp> | undefined): boolean {
  if (patterns === undefined) {
    return false;
  }
  return patterns.some((p) => (typeof p === 'string' ? href.includes(p) || host === p : p.test(href)));
}

/** Origin of the configured ingestion endpoint, so we never instrument the SDK's own telemetry egress. */
function ingestionOrigin(): string | undefined {
  const endpoint = getSdkRuntime().initConfig?.endpoint;
  if (endpoint === undefined || endpoint === '') {
    return undefined;
  }
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

/**
 * Classifies an outbound URL into `ignored` / `internal_service` / `external_api`.
 * Calls to the ingestion endpoint are always ignored. `allowUrls` (when set) restricts what is instrumented.
 */
export function classifyOutboundUrl(url: URL, options: OutboundHttpOptions): OutboundClassification {
  const ingest = ingestionOrigin();
  if (ingest !== undefined && url.origin === ingest) {
    return { kind: 'ignored' };
  }
  if (matchesAny(url.href, url.host, options.ignoreUrls)) {
    return { kind: 'ignored' };
  }
  if (
    options.allowUrls !== undefined &&
    options.allowUrls.length > 0 &&
    !matchesAny(url.href, url.host, options.allowUrls)
  ) {
    return { kind: 'ignored' };
  }
  const mapped = options.internalServiceMap?.[url.host] ?? options.internalServiceMap?.[url.hostname];
  if (mapped !== undefined && mapped !== '') {
    return { kind: 'internal_service', serviceName: mapped };
  }
  const resolved = options.serviceNameResolver?.(url);
  if (resolved !== undefined && resolved !== '') {
    return { kind: 'internal_service', serviceName: resolved };
  }
  return { kind: 'external_api' };
}

/** Sanitized target (`host` + `pathname`, no query string) used for the span name / `http_route` attribute. */
export function sanitizedTarget(url: URL): string {
  return `${url.host}${url.pathname}`;
}
