/**
 * Canonical metadata keys for cc-stacktracer (dot-notation aligned with OpenTelemetry-style attributes).
 * Use these when building context / metadata so ingestion and rollups stay consistent.
 */

export const META = {
  HTTP_METHOD: 'http.method',
  HTTP_URL: 'http.url',
  HTTP_ROUTE: 'http.route',
  HTTP_DURATION_MS: 'http.duration_ms',
  HTTP_RESPONSE_STATUS: 'http.response.status_code',
  HTTP_SCHEME: 'http.scheme',
  HTTP_CLIENT_ADDRESS: 'http.client.address',
  HTTP_USER_AGENT: 'http.user_agent.original',

  DB_SYSTEM: 'db.system',
  DB_OPERATION: 'db.operation',
  DB_DURATION_MS: 'db.duration_ms',

  QUEUE_NAME: 'queue.name',
  QUEUE_DURATION_MS: 'queue.duration_ms',

  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',
  DEPLOYMENT_ENVIRONMENT: 'deployment.environment',

  SPAN_NAME: 'span.name',
  SPAN_DURATION_MS: 'span.duration_ms',

  INTERNAL_OPERATION: 'internal.operation',
  INTERNAL_DURATION_MS: 'internal.duration_ms',
} as const;

/** Nested `http` object for request-derived logs and performance events. */
export type HttpMetadataBlock = {
  method?: string;
  url?: string;
  route?: string;
  duration_ms: number;
  response_status_code?: number;
  scheme?: string;
  client?: { address?: string };
  'user_agent.original'?: string;
};
