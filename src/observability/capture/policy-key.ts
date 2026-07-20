/** Composite cache key: service + NUL + environment (multi-tenant-safe string). */
export function buildCapturePolicyKey(service: string, environment: string): string {
  return `${service}\0${environment}`;
}

/** Stable cache key for the canonical dashboard service UUID. */
export function buildCapturePolicyServiceIdKey(serviceId: string): string {
  return `service_id\0${serviceId}`;
}
