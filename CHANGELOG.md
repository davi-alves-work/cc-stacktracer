# Changelog

All notable changes to the `cc-stacktracer` SDK are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-07-22

### Changed

- Client-aborted HTTP requests no longer mark the root span as `status: 'error'`. An abort is a
  transport fact (connection closed before the response finished), not an operation failure — the
  server classifies it from the new flag instead of treating it as an application error.

### Added

- Optional `http_aborted` boolean on HTTP root spans (`true` when the client closed the connection
  early). Additive on the v4 span shape; omitted/`false` means not aborted.
- Shared `httpRootSpanOutcome` helper used by the Express, Fastify, and Adonis integrations so
  abort semantics stay consistent across frameworks.

## [2.0.0] - 2026-07-20

First release published to the public npm registry. Install with
`npm install cc-stacktracer` — no more tarball handoff.

### Changed

- **BREAKING — the package is now named `cc-stacktracer`** (previously `cc-stacktrace`).
  The public API is unchanged: same exports, same options, same behavior. Only the module
  specifier changed, which is why this is a major bump rather than a minor one.

#### Migration from 1.x

Two mechanical steps, no code logic changes:

```bash
npm uninstall cc-stacktrace
npm install cc-stacktracer
```

Then update every import specifier — the subpaths keep the same names:

```diff
- import { StackTrace } from 'cc-stacktrace';
+ import { StackTrace } from 'cc-stacktracer';

- import stacktracePlugin from 'cc-stacktrace/fastify';
+ import stacktracePlugin from 'cc-stacktracer/fastify';
```

A find-and-replace of `cc-stacktrace` → `cc-stacktracer` across your source is sufficient.
Verify with `npm ls cc-stacktracer` and confirm no `cc-stacktrace` remains in `package.json`.
Nothing on the wire changes: `service_id`, API keys, ingestion endpoints and the payload
contract (`schema_version: 4`) are all unaffected, so no dashboard or platform-side change is
needed.

### Added

- The client integration playbook (including the AI prompt pack) and the payload quality
  checklist now ship **inside the package**, under `node_modules/cc-stacktracer/docs/`, alongside
  the Cursor rule files in `node_modules/cc-stacktracer/cursor-rules/`. They no longer have to be
  delivered by hand.
- `LICENSE` (MIT) is now included in the published package — the license was declared in
  `package.json` but the file itself was missing.

## [1.2.0] - 2026-07-20

### Fixed

- **`withBusinessContext`/`withBusinessContextAsync` now populates span `attributes`**, not only
  log/error events. Previously `getBusinessContext()` was read only by the event-context merge
  path, so a span wrapped in an active business-context scope still got an empty/near-empty
  `attributes`/`metadata_json`. Spans now merge in `entity`/`operation`/`fields_changed` from the
  active scope; explicit `attributes` passed to the call still win on key collision. Transparent:
  no client code change — an existing client using `withBusinessContext` around instrumented spans
  will see previously-empty `metadata_json` populated on those spans going forward. If you have
  dashboards or alert rules keyed on span `metadata_json` being empty, review them after
  upgrading — this is new data appearing, not a wire-format change.

### Added

- `runQuery`/`measure` accept an `attributes?: Record<string, unknown>` option for custom span
  metadata, independent of the business-context merge above.
- Optional `onDroppedContextKey` diagnostic, surfaced via the existing `logger` option on
  `StackTrace.init`: warns when a `context`/`attributes` object/array value under an unrecognized
  key would otherwise be silently dropped during event normalization (e.g. the
  `captureException(error, { context: {...} })` double-wrap mistake). The warning fires once per
  dropped key per event and is not deduplicated — a systematic mistake in a hot path will be
  noisy by design. Wire the `logger` in non-production environments.

### Changed

- **`telemetry.sdk.version` now reports the real package version.** `SDK_VERSION` had drifted to
  `0.1.0` while the package was at `1.1.0`, so every event's resource attributes reported the
  wrong SDK version and there was no reliable way to tell from telemetry which clients were on
  which build. Now synced to the released version.

## [1.1.0] - 2026-07-11

### Fixed

- **db-lucid: DB spans no longer report ~0ms durations.** The plugin read `q.response` from
  knex's `query` event, but knex emits `query` _before_ executing the statement and never
  attaches the response promise to that event — the span measured an `await undefined` (~0µs)
  while metadata stayed correct. Spans are now measured by pairing `query` with
  `query-response` / `query-error` through knex's per-query `__knexQueryUid`: real durations,
  real start/end times, and failed queries recorded with `status: 'error'` and the error
  message. Autogenerated notifications without a completion event (e.g. mssql
  `BEGIN/SAVE/ROLLBACK TRANSACTION`) no longer produce meaningless 0ms spans, and the
  in-flight registry is bounded (oldest entry dropped past 1,000 pending queries).
  Transparent: no client code change.
- **db-prisma: concurrent queries no longer nest under each other.** Sibling queries started
  concurrently (e.g. via `Promise.all`) were parented to the previously started query's span
  instead of the enclosing HTTP/root span, rendering a wrong waterfall hierarchy. Prisma DB
  spans are now leaf spans (same contract as outbound HTTP client spans). Durations were
  always measured correctly on this integration. Transparent: no client code change.

### Added

- `runQuery` accepts `leaf?: boolean` — when true the span never becomes the parent of spans
  started while the query is in flight, so concurrent queries each parent to the enclosing
  span (used internally by the Prisma integration; default `false`).
- `beginOutboundSpan` / `endOutboundSpan` (and the `OutboundSpanStart` type) are exported from
  the package root for building event-paired leaf spans in custom integrations.

## [1.0.1] - 2026-06-20

### Fixed

- **Root HTTP span is now emitted on every request outcome.** Previously the server (root) span
  was only recorded on a successful response (`finish` / `onSend`). Long-running requests that
  were aborted or timed out before the response completed never emitted the root span, so the
  trace lost its route and the child (`db`) spans were left orphaned. The Fastify, Express and
  Adonis integrations now emit the root span exactly once on any terminal outcome — completed,
  aborted, or timed out — via a `close`-event fallback. Aborted/timed-out requests are recorded
  with `status: 'error'`, `error_type: 'aborted'`, and a null `http_status_code`. Transparent:
  no client code or wire-contract change.

## [1.0.0] - 2026-06-20

First stable major. Bundles the **payload v4 cutover** (breaking wire contract) with
**distributed tracing** (inbound parent adoption + opt-in outbound propagation).

> The major bump is driven by the v4 cutover — the wire contract changed and legacy
> payloads are rejected. The distributed-tracing additions are themselves additive/opt-in.

### Added

- **Inbound remote-parent adoption.** The root span adopts `parent_span_id` from a valid
  inbound `traceparent` header (Fastify / Express / Adonis / generic HTTP), so a request
  entering an instrumented service links to its upstream caller. Transparent — no client code
  change and no wire-contract change (the `parent_span_id` field already existed on v4 spans).
- **Outbound trace propagation (opt-in).** `instrumentFetch()` and `instrumentNodeHttp()`
  create an `external` client span per outbound call and inject `traceparent` carrying the
  client span id, so the downstream service parents itself to that span. `node:http`/`https`
  instrumentation covers libraries that go through `require('http')` (axios, got,
  follow-redirects) on Node. Enable via:
  ```ts
  StackTrace.auto({ outboundHttp: { instrumentFetch: true, instrumentNodeHttp: true } });
  // or directly: StackTrace.instrumentFetch(opts?) / StackTrace.instrumentNodeHttp(opts?)
  ```
  Client spans are **leaf** spans (never pushed on the active span stack), so concurrent calls
  do not mis-parent. Instrumentation is idempotent and never traces the configured ingestion
  endpoint (no self-tracing).
- **URL classification & controls** for outbound spans: ignore the ingestion endpoint,
  `ignoreUrls` / `allowUrls`, and internal-vs-third-party tagging via `peer.kind` / `peer.service`
  (driven by `internalServiceMap` / `serviceNameResolver`). No request/response headers captured
  by default.
- **`trace_flags` propagation** end-to-end (W3C Trace Context), inbound and outbound.
- **Dashboard distributed-trace UX:** cross-service waterfall tree grouped by service, per-row
  service badges, and a partial-trace diagnostics panel (service count, orphan-span warning).

### Changed

- **Spans are v4-canonical:** `duration_us` (microseconds) + `status` (`unset|ok|error`) +
  `attributes`. `duration_ms` / `is_error` are derived server-side. Promoted attributes
  (`http_*`, `db_*`, `trace_flags`) become ClickHouse columns; the rest land in `metadata_json`.

### Removed / Breaking

- **Event payload is v4-only (`schema_version: 4`).** The ingestion boundary
  (`parseIngestEventStrictV4`) rejects any other version with HTTP 400. Legacy v1/v2/v3 are no
  longer an accepted wire contract.
- **v4 is snake_case with W3C-hex trace ids:** `trace_id` 32 hex, `span_id` / `parent_span_id`
  16 hex.
- **Event `type` is `log | error` only.** The v3 `performance` type was removed — timing lives
  in spans.
- **The `request` log-event was dropped.** Integrations emit spans only (no duplicate
  request log-event per HTTP request).
- **Events must carry `service_id`** (stable UUID from `/services`); the server injects
  `tenant_id` / `project_id` from the API key. Clients must never set those server-owned fields.
- **Removed SDK exports:** legacy `EventSchema` / `EventSchemaV2` / `normalizeEvent` /
  `eventV1ToV3` and the legacy normalizers. **New exports:** `EventSchemaV4`, `normalizeEventV4`,
  `EventV4`, `CanonicalInput`.
- **Platform (server-side):** the legacy Postgres `spans` table was dropped (ingestion migration
  `047_drop_spans_table.sql`); spans live only in ClickHouse `observability_spans`.

### Migration guide (clients on a previous tarball)

1. Upgrade the tarball to `cc-stacktracer-1.0.0.tgz` (see
   [docs/client-node-tgz-installation.md](docs/client-node-tgz-installation.md)).
2. If you use the SDK facade/integrations, the v4 wire bump is automatic
   (`normalizeEventV4`) — no event-shape code change needed. If you import the removed legacy
   schemas/normalizers directly, switch to the v4 exports above.
3. To turn on cross-service tracing, opt in to outbound propagation via
   `StackTrace.auto({ outboundHttp: { ... } })` — see
   [docs/client-distributed-tracing.md](docs/client-distributed-tracing.md).
