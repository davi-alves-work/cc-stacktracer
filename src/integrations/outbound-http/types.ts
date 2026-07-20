/**
 * Options for outbound HTTP instrumentation (fetch / node http / axios).
 * All adapters are **opt-in/explicit** (D2): the SDK never patches outbound clients automatically.
 */
export type OutboundHttpOptions = {
  /** Inject `traceparent` into outbound requests so the downstream service joins this trace. Default true. */
  propagateTraceparent?: boolean;
  /** Skip instrumentation for URLs matching any entry (substring/host match for strings; `test()` for RegExp). */
  ignoreUrls?: Array<string | RegExp>;
  /** When set and non-empty, ONLY instrument URLs matching one of these (others are ignored). */
  allowUrls?: Array<string | RegExp>;
  /** Map of host (optionally `host:port`) → logical internal service name (classifies the call as internal). */
  internalServiceMap?: Record<string, string>;
  /** Resolve a logical internal service name for a URL; returning a non-empty string classifies it as internal. */
  serviceNameResolver?: (url: URL) => string | undefined;
};

/** Classification of an outbound call. span_type stays `external` (D3); this drives the `peer.*` attributes. */
export type OutboundClassification =
  | { kind: 'ignored' }
  | { kind: 'internal_service'; serviceName: string }
  | { kind: 'external_api' };
