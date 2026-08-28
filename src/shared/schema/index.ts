export {
  EventLevelSchema,
  EventTypeSchema,
  ServiceSchema,
  TraceSchema,
  HttpBlockSchema,
  DbBlockSchema,
  QueueBlockSchema,
  UserBlockSchema,
  iso8601TimestampSchema,
} from './event.schema.js';
export type { CanonicalInput } from './event.schema.js';

/** Canonical event v4 (strict) — W3C trace ids, snake_case wire contract. Single source of truth. */
export {
  EventSchemaV4,
  EventTypeV4Schema,
  TraceSchemaV4,
  w3cTraceId,
  w3cSpanId,
  W3C_TRACE_ID_RE,
  W3C_SPAN_ID_RE,
} from './canonical-event-v4.schema.js';
export type { EventV4 } from './canonical-event-v4.schema.js';
export { HttpSchema } from './http.schema.js';
export { DbSchema } from './db.schema.js';
export { BusinessSchema } from './business.schema.js';
export { RuntimeSchema } from './runtime.schema.js';
export { ResourceSchema } from './resource.schema.js';
export { TagsSchema } from './tags.schema.js';
export { ErrorSchema } from './error.schema.js';
export { IngestionMetadataSchema, MetadataSchema } from './metadata.schema.js';
export { UserSchema } from './user.schema.js';
export type { UserMetadata } from './user.schema.js';
export { segmentLooksLikeRawId, routeHasRawDynamicSegments, maskDynamicRouteSegments } from './route-validation.js';
export { normalizeEventV4, eventV1ToV4, pickV3HttpRoute } from '../normalizers/normalize-event.js';
export { normalizeHttpRouteForSpan } from '../normalizers/http-route-normalize.js';
export { coerceToCanonicalInput } from './normalize.js';
export type { NormalizeOptions } from './normalize.js';
export {
  CAPTURE_POLICY_MAX_ENDPOINT_LEN,
  CAPTURE_POLICY_MAX_RULES,
  captureEventTypeSchema,
  capturePolicyLegacyWireSchema,
  capturePolicyV2WireSchema,
  captureRuleSchema,
  compileCapturePolicy,
  compileCapturePolicyFromRawOrNull,
  compiledToV2Wire,
  DEFAULT_COMPILED_CAPTURE_POLICY,
  evaluateCapture,
  evaluateCaptureDiagnostics,
  parseAndCompileCapturePolicy,
  spanRowToCaptureEventType,
} from './capture-policy-engine.js';
export { CAPTURE_POLICY_REDIS_CHANNEL, capturePolicyRedisUpdatePayloadSchema } from './capture-policy-redis-payload.js';
export type { CapturePolicyRedisUpdatePayload } from './capture-policy-redis-payload.js';
export type {
  CaptureDefaultMap,
  CaptureEvaluationContext,
  CaptureEvaluationDiagnostics,
  CaptureEventType,
  CapturePolicyLegacyWire,
  CapturePolicyV2Wire,
  CaptureRule,
  CompiledCapturePolicy,
  CompiledCaptureRule,
  EvaluateCaptureOptions,
} from './capture-policy-engine.js';
