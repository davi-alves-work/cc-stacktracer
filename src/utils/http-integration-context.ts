import type { CorrelationFields } from './correlation.js';
import { hasCorrelationData } from './correlation.js';

export type HttpIntegrationExtras = {
  route?: string | undefined;
  clientIp?: string | undefined;
  userAgent?: string | undefined;
  scheme?: string | undefined;
};

function trimOrUndef(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t === '' ? undefined : t;
}

/**
 * Builds `context` for request events: nested `http` (OTel-oriented keys) plus optional `correlation`.
 */
export function buildHttpIntegrationContext(
  correlation: CorrelationFields,
  extras: HttpIntegrationExtras,
): Record<string, unknown> | undefined {
  const http: Record<string, unknown> = {};
  const route = trimOrUndef(extras.route);
  const clientIp = trimOrUndef(extras.clientIp);
  const userAgent = trimOrUndef(extras.userAgent);
  const scheme = trimOrUndef(extras.scheme);

  if (route !== undefined) http.route = route;
  if (clientIp !== undefined) http['client.address'] = clientIp;
  if (userAgent !== undefined) http['user_agent.original'] = userAgent;
  if (scheme !== undefined) http.scheme = scheme;

  const out: Record<string, unknown> = {};
  if (Object.keys(http).length > 0) {
    out.http = http;
  }
  if (hasCorrelationData(correlation)) {
    out.correlation = correlation;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
