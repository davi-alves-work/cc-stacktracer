# CC StackTrace Client Installation and Integration Playbook

This playbook is a technical, execution-first guide for integrating `cc-stacktracer` into client applications.
It is stack-agnostic, with examples in Node.js/Fastify/Adonis style where useful.

**Payload quality checklist (mandatory before go-live):** [client-payload-quality-checklist.md](./client-payload-quality-checklist.md)

**Integration quality defaults (§19 — first implementation gate):** see section 19 in this document.

**Payload field reference (§20 — implementers):** see section 20 in this document. Didactic introduction: [README — Understanding payloads](../README.md#understanding-payloads--field-by-field-v4).

**Distributed tracing (cross-service traces — enable outbound propagation):** [client-distributed-tracing.md](./client-distributed-tracing.md)

## 1) Scope

This guide covers:
- SDK installation and bootstrap in client applications
- environment variable setup and validation
- auth/signature expectations for ingestion requests
- rich telemetry instrumentation (HTTP, business, DB, spans, errors)
- operational validation gates for integration quality
- first-class integration defaults for go-live (section 19)
- payload field reference for implementers (section 20)

This guide does not cover:
- platform deployment/infrastructure of CC StackTrace itself
- dashboard operational administration

## 2) Preconditions and integration contract

Before starting:
- You have a valid `STACKTRACE_API_KEY` for the target project.
- You have the correct `STACKTRACE_SERVICE_ID` copied from `/services`.
- You have the ingestion base URL (`STACKTRACE_ENDPOINT`) without `/v1/events` suffix.
- You can run the application in at least one non-production environment.

Integration contract:
- Client team owns payload quality.
- Every important flow must include enough context to answer: who, what, where, when, and why it failed.
- Secrets must never be logged.
- **`STACKTRACE_SERVICE_ID` is the canonical service identity.** The platform resolves display names from the dashboard registry; client `service` labels are optional and must not be used as the source of truth for grouping.

## 3) Phase 1 - SDK installation and bootstrap

### 3.1 Install

```bash
npm install cc-stacktracer
```

Or, if distributed as tarball, use the **latest** `.tgz` under `artifacts/releases/` (check the
directory or `package.json#version` — do not assume the version number below stays current):

```bash
npm install ./artifacts/releases/cc-stacktracer-1.2.0.tgz
```

### 3.2 Initialize once on startup

```ts
import { StackTrace } from 'cc-stacktracer';

StackTrace.init({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  // Optional human label for logs; platform grouping uses serviceId from dashboard.
  service: 'my-api',
  release: process.env.GIT_SHA ?? process.env.npm_package_version,
  capturePolicyRefreshMs: Number(process.env.STACKTRACE_CAPTURE_POLICY_REFRESH_MS ?? 0),
});
```

Identity rules:
- **`serviceId` (UUID)** is mandatory and must match the service row in the dashboard.
- **`service` (string)** is optional. If omitted, the SDK may emit a fallback like `service-<id-prefix>` in raw JSON — the platform still groups by `serviceId`.
- **`release`** is strongly recommended so spans/events are not stored with `service_version: "unknown"` or placeholder values like `"0.0.0"` when a real build identifier exists.

### 3.3 Validation gate

- App starts without env parsing errors.
- At least one `StackTrace.log(...)` appears in the platform.
- Events/spans are associated with the intended `serviceId` (UUID), not only a free-form service name.

## 4) Phase 2 - Environment variables and identity

### Required vars

```env
STACKTRACE_API_KEY=...
STACKTRACE_SERVICE_ID=00000000-0000-0000-0000-000000000000
STACKTRACE_ENDPOINT=https://ingest.example.com
```

### Optional critical var

```env
STACKTRACE_CAPTURE_POLICY_REFRESH_MS=120000
```

Guidance:
- `0` or omitted disables polling.
- Very low values can increase policy traffic and add noise.
- Keep values practical (for example 60s to 300s) unless you have strict dynamic policy needs.

### Common mistakes

- Using `STACKTRACE_ENDPOINT` with `/v1/events` already appended.
- Using unknown/non-registered `serviceId`.
- Mixing API keys from one project with service IDs from another.

### Validation gate

- Startup validates env values up front.
- Invalid setup fails fast and explicitly.

## 5) Phase 3 - Auth/signature and request security

**Request signing is automatic — do not implement it.** Every `POST /v1/events` and
`POST /v1/spans` call made by the SDK already carries `x-api-key` plus an HMAC-SHA256
request signature (`x-timestamp`, `x-nonce`, `x-signature`), computed in
`signIngestionRequest` (SDK transport) and verified server-side by `IngestionSignatureService`.
There is nothing to build here — writing your own signing code would just create a second,
conflicting signature. This phase is about the guarantees your environment must hold so the
built-in signing keeps working, and how to read a signature failure.

What is automatic:
- Canonical string: `v1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n sha256:<hex body hash>`, HMAC-SHA256 keyed
  by the API key, sent as `x-signature: v1=<hex>`.
- A fresh `x-nonce` (UUID) and `x-timestamp` (ISO-8601) per request.
- Replay protection: the server stores each nonce in Redis (`SET ... NX`) for
  `INGESTION_SIGNATURE_NONCE_TTL_SECONDS` (default 300s) — a nonce reused inside that window is rejected.

What you must guarantee:
- **API key stays secret.** The signature is only as strong as the key; never log it, put it in
  client-side (browser) bundles, or commit it to source control.
- **Server clock is synced (NTP).** Requests are rejected if `|now - x-timestamp|` exceeds
  `INGESTION_SIGNATURE_MAX_SKEW_SECONDS` (default 300s). Clock drift is the most common cause of
  signature failures in production, not a code bug.
- **HTTPS in all non-local environments** — the signature protects integrity/replay, not
  confidentiality in transit.
- Never log the raw `x-signature` / `x-nonce` headers or attempt to reuse a nonce across retries;
  let the SDK generate a new one per attempt.

Troubleshooting signature-related `401/403`:

| Server error code | Likely cause |
|---|---|
| `STALE_TIMESTAMP` | Client or ingestion server clock drift beyond the skew window |
| `REPLAYED_NONCE` | Same request retried/duplicated with the same nonce inside the TTL window |
| `INVALID_SIGNATURE` | Wrong/rotated API key, or a body mutated by a proxy/gateway after signing |
| `INVALID_NONCE` / `MISSING_SIGNATURE_HEADER` | Custom HTTP client/proxy stripping or rewriting headers instead of using the SDK transport |
| `NONCE_STORE_UNAVAILABLE` | Ingestion-side Redis outage — not a client-side issue |

### Validation gate

- Ingestion accepts authenticated requests (`2xx/202`) for valid credentials.
- Invalid credentials/signatures are rejected with safe errors (no signature/key echoed back).
- No intermediary (proxy, API gateway, WAF) rewrites the request body or headers between the SDK
  and the ingestion endpoint — that breaks `x-signature` even with a correct API key.

## 6) Phase 4 - HTTP middleware and rich request payloads

Capture request telemetry in middleware (Fastify/Express/Adonis equivalent):
- HTTP method
- normalized route/path template
- status code
- duration
- request correlation fields (`x-request-id`, `traceparent`)

### Example pattern

```ts
const start = Date.now();
try {
  // handler...
} finally {
  StackTrace.logStructured({
    level: 'info',
    message: 'http.request',
    operation: 'http.request',
    duration_ms: Date.now() - start,
    // NOTE: the field is `attributes`, not `context` — `StructuredLogInput` has no `context`
    // key, so passing `context: {...}` here is silently dropped (compiles to nothing on the wire).
    attributes: {
      http: { method, route, status_code: statusCode },
      correlation: { requestId, traceparent },
    },
  });
}
```

### Validation gate

- Requests are searchable by route/method/status.
- Traces include correlation IDs consistently.

## 7) Phase 5 - Business context and structured logs

**`withBusinessContext(Async)` today only carries `entity` / `operation` / `fields_changed`.**
Its TypeScript type (`BusinessContext`) has no `userId`/`accountId`/`role`/`userEmail`/`result`/
`impact` fields, and even if you smuggle extra keys past the type, the wire schema
(`BusinessSchema` — `entity`, `operation`, `fields_changed`, `user_id`) silently strips anything
else during **event** normalization. Spans are different: business context propagates into span
`attributes` automatically (see section 19.4). Use it for the two fields it actually supports:

```ts
await StackTrace.withBusinessContextAsync(
  { entity: 'invoice', operation: 'approve' },
  async () => {
    // nested log/error calls in this scope inherit metadata.business.{entity,operation}
  },
);
```

**For authenticated-user identity and free-form business facts (`result`, `impact`, `userId`,
`accountId`, `role`, `userEmail` if policy allows), pass them explicitly on each `logStructured`/
`captureException` call as scalar attributes.** Scalar keys not recognized as a structured block
(`http`, `db`, `business`, `correlation`, …) are automatically promoted to `metadata.tags`
(string-keyed, string-valued) — this is what actually reaches ClickHouse today, and it is the
mechanism the payload examples in section 17.3 rely on.

### Example

```ts
StackTrace.logStructured({
  level: 'info',
  message: 'invoice.approval.started',
  attributes: {
    entity: 'invoice',
    operation: 'approve',
    result: 'success',
    impact: 'financial',
    userId: auth.user.id,
    accountId: auth.user.accountId,
    role: auth.user.role,
    // userEmail only if policy allows PII in telemetry
    invoiceId,
    source: 'api',
  },
});
```

If you want `entity`/`operation` to also inherit into `metadata.business` (for the strict-schema
readers that key off it), combine both: wrap with `withBusinessContext({ entity, operation }, fn)`
**and** repeat the identity/result/impact fields as flat attributes on each call inside — they are
not redundant, they land in different places (`metadata.business` vs `metadata.tags`).

### Validation gate

- You can query by business entity + operation + user (via `metadata.tags`, since identity fields
  do not live in `metadata.business` today).
- Errors inside business flows inherit this context.
- Critical flows produce spans with non-empty `metadata_json` (business tags propagate to HTTP and DB child spans — see section 19.4).

## 8) Phase 6 - Database instrumentation with `runQuery()`

Map **every** repository/DAO/data-access module first (this is what Prompt A in section 14 is
for), then instrument with `runQuery()`. "Map all points" means no data-access path is left
unknown — it does not mean wrapping trivial internal lookups with no diagnostic value. Prioritize
writes, anything on a critical business flow, and any query that has actually failed in
production. See the "instrumenting every trivial query" anti-pattern in section 13.

### ORM-style example

```ts
return StackTrace.runQuery('postgres', 'user.findById', () => prisma.user.findUnique({ where: { id } }), {
  table: 'users',
});
```

### Raw SQL example

```ts
return StackTrace.runQuery(
  'postgres',
  'orders.insert',
  () => db.query('INSERT INTO orders(id, amount) VALUES($1, $2)', [id, amount]),
  { table: 'orders' },
);
```

### NoSQL-style example

```ts
return StackTrace.runQuery(
  'mongodb',
  'audit.insertOne',
  () => mongo.db('app').collection('audit').insertOne(payload),
  { table: 'audit' },
);
```

When query code throws:
- SDK captures enriched DB error context
- marks DB span as errored
- rethrows the original error to preserve control flow

### Options that change span shape

- **`leaf: true`** — use for queries that run **concurrently** (`Promise.all`, parallel
  repository calls). Without it, spans nest under whichever query happens to still be open when a
  sibling starts, producing a fake parent/child chain instead of siblings under the enclosing
  span. With `leaf: true` each query attaches directly to the enclosing span regardless of timing.
- **`captureError: false`** — use when the calling code already captures the exception at a
  higher boundary (e.g. the global HTTP error handler in section 10). Without it, a query error
  wrapped in `runQuery` is captured twice: once here, once at the handler.

```ts
await Promise.all([
  StackTrace.runQuery('postgres', 'orders.totals', () => db.query(totalsSql), {
    table: 'orders',
    leaf: true,
  }),
  StackTrace.runQuery('postgres', 'orders.items', () => db.query(itemsSql), {
    table: 'order_items',
    leaf: true,
  }),
]);
```

### Validation gate

- DB spans appear with system + operation + table/collection metadata.
- DB failures are visible with diagnostic context.
- DB spans record `duration_ms > 0` when the query took measurable time (see section 19.5).
- Concurrent queries in the same trace appear as siblings, not nested inside each other.

## 9) Phase 7 - Spans and end-to-end correlation

Target hierarchy:
- request span
- business span(s)
- db span(s)

Use manual spans only when needed for critical non-DB operations.

### Example

```ts
await StackTrace.withSpan({ type: 'service', name: 'billing.charge' }, async () => {
  // external call + domain logic
});
```

### Validation gate

- Trace timeline is readable and linked (not fragmented).
- Child spans can be traced back to the request origin.

## 10) Phase 8 - Global error handler with enriched payloads

Capture technical exceptions with safe metadata:
- driver/system error code
- operation name
- component/module
- request/span correlation IDs (`metadata.correlation.requestId`, trace ids)
- **HTTP context when the failure happened inside a request:**
  - `metadata.http.method`
  - `metadata.http.route` as a **route template** (never `/unnormalized`)
  - `metadata.http.status_code` matching the real HTTP response (4xx/5xx on failure)
  - `metadata.http.duration_ms` from the request timer

Do not include:
- credentials
- secret tokens
- full SQL with sensitive literals

### Pattern

Reuse the same capture helper in the **global exception handler**, **middleware catch paths**
(tenant resolution, auth, session), and explicit repository captures:

```ts
function captureHttpAwareException(
  error: unknown,
  req: { method: string; routerPath?: string; url: string; protocol?: string; requestStartMs: number; requestId: string },
  res: { statusCode?: number },
) {
  const routeTemplate = req.routerPath ?? normalizeRouteTemplate(req.url);
  const statusCode =
    res.statusCode && res.statusCode !== 200 ? res.statusCode : mapExceptionToHttpStatus(error);

  // `captureException(error, context)` — the second argument IS the context object.
  // Do NOT wrap it again as `{ context: { ... } }`: that nests everything one level too
  // deep under a key named "context", which the normalizer does not recognize as a
  // structured block (it isn't `http`/`db`/`business`/`correlation`) and isn't a scalar
  // either, so it is silently dropped — the error would ship with none of this data.
  StackTrace.captureException(error as Error, {
    component: 'orders-service',
    operation: 'orders.create',
    http: {
      method: req.method,
      route: routeTemplate,
      status_code: statusCode,
      duration_ms: Date.now() - req.requestStartMs,
      scheme: req.protocol,
    },
    correlation: { requestId: req.requestId },
    driverCode: (error as { code?: string }).code,
  });
}
```

**Route field rules:**

| Field | Correct | Incorrect |
|-------|---------|-----------|
| `metadata.http.route` / `context.http.route` | `/api/users/:id` | `/api/users/123` |
| | `/login` | `GET /login` (method belongs in `method`, not `route`) |
| | `/orders` | `/unnormalized` |

### Middleware and early failures

Failures that occur **before** the controller (tenant resolver, auth guard, session middleware)
are a frequent source of low-quality error payloads: `status_code: 0`, `duration_ms: 0`, or
`route: "GET /login"`.

Requirements for middleware `captureException` calls:

- set `route` to the **route template** (never prefix with HTTP method)
- set `status_code` to the response actually sent (403, 404, 422, etc.)
- set `duration_ms` from the request start timestamp (must be `> 0` when a request was received)
- include `metadata.correlation.requestId` (same ID as HTTP access logs)

### Validation gate

- Handled and unhandled failures are observable with enough context for triage.
- Error samples do **not** show `http.route: "/unnormalized"`, `http.route` with an embedded HTTP method, or `http.status_code: 200` on server/validation failures.
- Error payloads include the same `metadata.correlation` block as HTTP logs for the same request.
- Validation failures use 4xx status codes (for example 422), not 200.

## 11) Phase 9 - Final smoke validation (Definition of Done)

Run and verify all 4 scenarios:
1. success flow with structured + business context
2. successful `runQuery()` flow
3. failing DB flow (`runQuery` + enriched error)
4. one manual span flow

Also run the **go-live validation scenarios** in section 19.8 (validation failure, middleware
abort, correlation match).

Integration is accepted only if:
- events arrive for all scenarios
- correlation is preserved between request/business/db
- payloads are rich and consistent
- no secrets appear in captured data
- [Payload quality checklist](./client-payload-quality-checklist.md) P0 items are all checked
- section 19 P0 acceptance queries return zero defects

## 12) Troubleshooting matrix

- `401/403` from ingestion -> check API key scope and endpoint.
- Events without service identity -> verify `STACKTRACE_SERVICE_ID`.
- Spans missing correlation -> verify request context propagation and async boundaries.
- Noisy or sparse events -> recalibrate capture policy and `STACKTRACE_CAPTURE_POLICY_REFRESH_MS`.
- Duplicate events -> check duplicate middleware/hooks.
- **Overview shows 0 req/s / 0% errors but `/errors` has groups** -> HTTP spans are missing or outside the selected time range. Confirm `POST /v1/spans` traffic, HTTP plugin enabled, and the overview window includes recent data. Remember: `/errors` lists persisted exception events; overview KPIs require HTTP spans (see section 19.1).
- **Errors with `status_code: 200` or `duration_ms: 0`** -> fix error handler and middleware capture paths (section 19.3). The platform cannot infer real HTTP status from exception type alone.
- **DB spans mostly `duration_ms = 0`** -> ORM/query wrapper not closing spans after `await`; see section 19.5.
- **`service_version` is `unknown` or `0.0.0`** -> set `release` in `StackTrace.init` (section 19.2).

## 13) Critical anti-patterns

- Instrumenting every trivial query instead of high-value operations.
- Logging sensitive auth or personal data.
- Treating free-form messages as substitute for structured context.
- Capturing errors without operation/entity/user context.
- Shipping to production without smoke validation evidence.
- Relying on `service` string from the client instead of `serviceId` from the dashboard.
- Sending errors with `metadata.http.route: "/unnormalized"` or `status_code: 200` on failed requests.
- Putting HTTP method inside `http.route` (for example `route: "GET /login"` instead of `route: "/login"`).
- Omitting `metadata.correlation` on errors while only adding it on HTTP logs (including middleware failures).
- Putting raw identifiers (matricula, CPF, e-mail, tenant slugs) in `error.message` when opaque IDs suffice.
- Putting raw identifiers (matricula, CPF, e-mail) in `metadata.http.url` instead of route templates + optional business context.
- Leaving `service_version` as `"unknown"` or `"0.0.0"` on spans when `release` is available at startup.
- Rich business context on errors only, with empty `metadata_json` on all spans (see section 19.4).
- Marking HTTP 4xx/5xx spans with `is_error = 0` and `status = ok` without a documented team policy (section 19.6).

## 14) Prompt pack for AI-assisted implementation

### Prompt A - Integration mapping

```text
Map this codebase and propose exact insertion points for cc-stacktracer instrumentation:
1) SDK init bootstrap
2) HTTP middleware
3) business context wrappers
4) runQuery in every repository/DAO/data-access module (map all of them, even if not all get
   instrumented — see section 8 on which ones are worth wrapping)
5) global error handler
Do NOT propose writing request-signing/HMAC code — section 5 of this playbook explains it is
already automatic in the SDK transport.
Return concrete file paths and patch-ready code snippets.
```

### Prompt B - Business context standardization

```text
Refactor business instrumentation so every critical operation includes entity, operation, result,
impact, and authenticated user fields (userId, accountId, role; userEmail only if policy allows).

Constraints (see section 7 — these are not optional style points, they are correctness fixes):
- `StackTrace.withBusinessContext(Async)` only accepts { entity, operation, fields_changed? }.
  Do not pass userId/accountId/role/result/impact into it — they are silently dropped (both by
  the TypeScript type and by the wire schema).
- Pass result/impact/userId/accountId/role/userEmail as flat keys inside the `attributes` object
  of `logStructured` (or directly as the second argument of `captureException` — NOT wrapped in
  an extra `context: {...}` key, see section 10).
- Business context on spans (metadata_json) now auto-merges from an active
  `withBusinessContext`/`withBusinessContextAsync` scope — `entity`/`operation`/`fields_changed`
  land in span `attributes` automatically, no extra `withSpan` call needed for that. Only use the
  `attributes` option on `withSpan`/`runQuery`/`measure` for span-specific metadata that isn't
  business context (for example `impact`) — see section 19.4.

Keep payloads structured and avoid sensitive data leakage.
```

### Prompt C - DB instrumentation quality

```text
Wrap critical DB operations with StackTrace.runQuery for ORM, raw SQL, and NoSQL access paths.
Ensure operation names are stable and searchable.
Add minimal metadata (system, operation, table/collection) and keep error rethrow behavior intact.
Use `leaf: true` on any query that runs concurrently with others (Promise.all / parallel
repository calls) so spans don't nest into each other — see section 8.
Use `captureError: false` when the caller already captures the exception at the HTTP boundary, to
avoid double-capturing the same failure.
```

### Prompt D - Final verification audit

```text
Audit this repository for cc-stacktracer integration quality.
Check env contract, middleware coverage, business context richness, user identity inclusion when
authenticated (as flat attributes, not inside withBusinessContext — section 7), runQuery
coverage, span correlation, error-handler enrichment, and (if this service calls other
instrumented services) outbound traceparent propagation producing a single cross-service trace
tree.
Also check for these specific, previously-seen mistakes:
- `captureException(error, { context: {...} })` — double-wrapped; the second argument IS the
  context object, wrapping it again silently drops all of it (section 10).
- `logStructured({ context: {...} })` — wrong field name; must be `attributes` (section 6).
- Any event payload still built as `schema_version: 3` — only `schema_version: 4` is accepted by
  the ingest API today (section 17.1 / 20.2).
- `tenant_id`/`project_id` set explicitly by client code — these are server-owned, injected from
  the API key; client-set values must match the key's scope or are rejected (section 20.1).
Return a pass/fail checklist with exact missing items and suggested patches.
```

### Prompt E - Distributed tracing (outbound propagation)

```text
Goal: make this service part of end-to-end distributed traces, so a request that
fans out to other services shows up as ONE trace tree in cc-stacktracer.

Context:
- Inbound is already automatic: the SDK's HTTP integration adopts the incoming
  `traceparent` header, so this service links to its upstream caller with no change.
- Outbound is opt-in: you must instrument the HTTP calls THIS service makes so each
  one carries a `traceparent` for the downstream service to adopt.

Do this:
1) Find where this service makes outbound HTTP calls (fetch/undici, axios, got,
   node:http/https, internal API clients, webhooks).
2) Enable outbound instrumentation ONCE at startup, right after StackTrace.auto/init:
     StackTrace.auto({
       apiKey, endpoint, serviceId,
       outboundHttp: { instrumentNodeHttp: true, instrumentFetch: true },
     });
   - instrumentNodeHttp covers axios/got/follow-redirects on Node (they use node:http).
   - add instrumentFetch only if the app calls global fetch/undici directly.
3) Do NOT wrap calls manually and do NOT push outbound spans on the active span
   stack — the SDK creates a leaf `external` span and injects `traceparent` for you.
4) Optionally tag internal vs third-party hops with internalServiceMap /
   serviceNameResolver, and skip noisy URLs with ignoreUrls.

Constraints:
- Initialize once at startup, never per-request. Idempotent (double-calls are no-ops).
- The SDK never traces its own calls to STACKTRACE_ENDPOINT (no self-tracing).
- Do not capture request/response headers or bodies.

Verify:
- A request crossing two instrumented services shows ONE trace_id.
- The downstream root span's parent_span_id equals the upstream outbound (external)
  span's span_id.
- The trace detail renders one tree grouped by service, with no orphan spans on the
  happy path. If a downstream is not instrumented, the outbound span still appears and
  the trace is shown as partial (not an error).

Reference: docs/client-distributed-tracing.md.
```

## 15) Handoff checklist

- [ ] Required env vars are configured and validated.
- [ ] SDK initialized once at startup (`serviceId` UUID + optional `service`/`release`).
- [ ] HTTP middleware emits structured telemetry.
- [ ] Business context includes entity/operation and authenticated user identity when available.
- [ ] Critical DB paths wrapped with `runQuery`.
- [ ] Error handler captures enriched, safe technical context.
- [ ] End-to-end correlation verified in traces.
- [ ] Final smoke scenarios executed and documented.
- [ ] [Payload quality checklist](./client-payload-quality-checklist.md) completed (all P0 items).
- [ ] Section 19 integration quality defaults satisfied (ClickHouse acceptance queries).

## 16) Automation matrix (what is automatic vs what must be instrumented)

Use this matrix during client onboarding to avoid a common misunderstanding: `StackTrace.init(...)`
alone is not enough for production-grade observability.

| Telemetry area | Automatic? | Prerequisite | Client must configure? | Recommended level |
|---|---|---|---|---|
| SDK bootstrap connectivity | Partial | `StackTrace.init` with `apiKey`, `serviceId`, `endpoint` | Yes | Mandatory |
| HTTP events (request/response) | Yes (after plugin) | HTTP integration plugin (`cc-stacktracer/fastify` or equivalent) | Yes | Mandatory |
| Correlation (`x-request-id`, `traceparent`) | Partial | Correlation middleware/propagation | Yes | Mandatory |
| Inbound trace parent adoption (link to upstream caller) | Yes (after plugin) | HTTP integration active | No | Automatic |
| Outbound trace propagation (cross-service traces) | No (opt-in) | `auto({ outboundHttp: { instrumentNodeHttp, instrumentFetch } })` | Yes | Recommended (mandatory for multi-service traces) |
| HTTP spans | Yes (after plugin) | HTTP integration active | Yes | Mandatory |
| Database spans (Prisma/SQL/NoSQL) | Not fully | `runQuery` wrapper or DB extension | Yes | Mandatory on critical paths |
| Simple logs (`log`) | No | Explicit instrumentation calls | Yes | Recommended |
| Structured logs (`logStructured`) | No | Explicit instrumentation + payload convention | Yes | Strongly recommended |
| Business context (`withBusinessContext*`) | No | Service/use-case wrappers | Yes | Mandatory for traceability |
| Authenticated user in business context | No (by default) | Add `userId`/`accountId`/`role` when authenticated | Yes | Mandatory on protected routes |
| Technical error events (`captureException`) | Partial | Global error handler + explicit captures in critical failures | Yes | Mandatory |
| Enriched DB errors (`metadata.db`) | Yes (when using `runQuery`) | DB operations wrapped with `runQuery` | Yes | Mandatory |
| Global tags (`StackTrace.tag`) | No | Add tags at startup | Yes | Recommended |
| Graceful flush/shutdown | Not fully automatic | Shutdown hooks (`flush`/`shutdown`) | Yes | Recommended |

### Onboarding minimum acceptance baseline

A client integration should only be considered "ready" when these 6 items are complete:

1. Correct `StackTrace.init` contract (`apiKey`, `serviceId`, `endpoint`)
2. HTTP plugin/middleware active
3. Correlation propagation active (`x-request-id`, `traceparent`)
4. `withBusinessContext*` on critical business flows (with authenticated user fields when applicable)
5. `runQuery` on critical DB operations
6. Global error handler capturing enriched technical context safely

## 17) Payload catalog (rich-by-default contract)

This section defines practical payload targets for client integrations. Use these examples as the
baseline for "good telemetry quality", not just "telemetry exists".

### 17.1 General payload rules

Mandatory:
- Always include business semantics (`entity`, `operation`) for critical flows.
- Preserve correlation (`requestId`, `traceparent`, `trace_id`, `span_id`) whenever available.
- Use **`service_id` (UUID)** on every `schema_version: 4` event/span batch; treat dashboard
  service name as display metadata resolved by the platform. `schema_version: 4` is the **only**
  contract the ingest boundary accepts (`parseIngestEventStrictV4` rejects anything else with
  400) — see [payload-v4.md](./contracts/payload-v4.md).
- Distinguish correlation IDs:
  - **`metadata.correlation.requestId`** — application request id (`x-request-id` from your API)
  - **`events.correlation_id`** (storage) — ingest HTTP request id from the collector (do not confuse when debugging)
- Use stable operation names (`billing.charge`, `orders.insert`) to keep dashboards queryable.

Recommended:
- Include execution impact (`result`, `impact`, `duration_ms`, `rowsAffected` when applicable).
- Include authenticated user fields in business payload for protected flows.
- For HTTP events, include `metadata.http.client.address`, `metadata.http.scheme`, and `metadata.http.user_agent.original` when available.

Forbidden:
- API keys, tokens, raw signatures, passwords, cookies.
- Full SQL containing sensitive literals.
- Unbounded raw payload dumps from user input.

### 17.2 Business context rule (authenticated users)

When the request is authenticated, business payload should include identity fields in addition to
domain fields. This is required for reliable "who did what" investigations. See section 7 for why
`withBusinessContextAsync` alone is not enough — it only carries `entity`/`operation`; identity
and outcome fields must be passed as flat `attributes` on the actual `logStructured`/
`captureException` call so they are promoted to `metadata.tags`.

```ts
await StackTrace.withBusinessContextAsync({ entity: 'invoice', operation: 'approve' }, async () => {
  // operation body...
  StackTrace.logStructured({
    level: 'info',
    message: 'invoice.approve.completed',
    attributes: {
      result: 'success',
      impact: 'financial',
      userId: auth.user.id,
      accountId: auth.user.accountId,
      role: auth.user.role,
      // Optional by policy:
      userEmail: auth.user.email,
    },
  });
});
```

### 17.3 Payload examples by type

All examples use the **v4 wire contract** (`schema_version: 4` — the only version the ingest
boundary accepts; see §20.2). `trace_id` is 32 lowercase hex, `span_id`/`parent_span_id` are 16
lowercase hex (W3C format), not UUIDs. `event_id`, `timestamp`, and the `service` object are
required on every event — they are omitted from the older v3 examples this section used to show,
which would be rejected with 400 today.

#### A) Simple log (`log`)

```json
{
  "schema_version": 4,
  "event_id": "b3b4a6c2-2e1f-4b8a-9c2d-1a2b3c4d5e6f",
  "timestamp": "2026-07-20T12:30:45.000Z",
  "type": "log",
  "level": "info",
  "message": "Payroll import started",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "payroll-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "metadata": {
    "tags": { "module": "payroll", "batchId": "batch-20260527-01" }
  }
}
```

#### B) Structured log with duration (`logStructured`)

v4 has no `performance` event type — timing on a log is just `metadata.db.duration_ms` (or a
`duration_ms` tag); real timing/waterfall data belongs on **spans** (see G below).

```json
{
  "schema_version": 4,
  "event_id": "1a2b3c4d-5e6f-7089-a1b2-c3d4e5f60718",
  "timestamp": "2026-07-20T12:30:45.000Z",
  "type": "log",
  "level": "warn",
  "message": "Slow payroll consolidation",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "payroll-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "metadata": {
    "db": { "system": "postgres", "operation": "payroll.consolidate", "duration_ms": 4200 },
    "tags": { "rows": "15000", "job": "monthly-close" }
  }
}
```

Note: `metadata.tags` values must be **strings** (`TagsSchema`) — `"rows": "15000"`, not a bare
number.

#### C) Business log (rich context + authenticated user)

`entity`/`operation` land in `metadata.business` only when set via `withBusinessContext`
(section 7). Identity and outcome fields (`userId`, `accountId`, `role`, `result`, `impact`) are
not part of the `business` schema — send them as flat `attributes` on `logStructured`, which the
normalizer promotes to `metadata.tags`.

```json
{
  "schema_version": 4,
  "event_id": "8f5c1a2e-3b4d-4e6f-9a1b-2c3d4e5f6071",
  "timestamp": "2026-07-20T12:30:45.000Z",
  "type": "log",
  "level": "info",
  "message": "invoice.approve.completed",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "billing-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "metadata": {
    "business": { "entity": "invoice", "operation": "approve" },
    "tags": {
      "result": "success",
      "impact": "financial",
      "userId": "u-123",
      "accountId": "acc-42",
      "role": "manager"
    }
  }
}
```

#### D) Error payload (`captureException`)

```json
{
  "schema_version": 4,
  "event_id": "2e4f6081-a3c5-4e7f-b9d1-3e5f7091b3d5",
  "timestamp": "2026-07-20T12:30:46.192Z",
  "type": "error",
  "level": "error",
  "message": "Database timeout while creating order",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "orders-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "error": {
    "type": "TimeoutError",
    "message": "Database timeout while creating order",
    "stack": "TimeoutError: ... at ..."
  },
  "metadata": {
    "http": {
      "method": "POST",
      "route": "/api/orders",
      "status_code": 500,
      "duration_ms": 842
    },
    "correlation": { "requestId": "req-abc" },
    "db": {
      "system": "postgres",
      "operation": "INSERT",
      "table": "orders",
      "duration_ms": 143
    },
    "tags": {
      "component": "orders-service",
      "operation": "orders.create",
      "driverCode": "ETIMEOUT"
    }
  }
}
```

This is the wire shape produced by the corrected `captureHttpAwareException` pattern in section
10 — note `http`/`correlation`/`db`/`tags` sit directly under `metadata`, not nested under an
extra `context` key.

#### E) DB error from `runQuery` (enriched automatically)

```json
{
  "schema_version": 4,
  "event_id": "5a7c9e01-b2d4-4f60-8271-93a5c7e91031",
  "timestamp": "2026-07-20T12:30:47.005Z",
  "type": "error",
  "level": "error",
  "message": "Cannot insert duplicate key",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "orders-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "metadata": {
    "db": {
      "system": "sqlserver",
      "operation": "INSERT",
      "table": "orders",
      "duration_ms": 143
    }
  }
}
```

#### F) HTTP telemetry event

```json
{
  "schema_version": 4,
  "event_id": "6b8d0f12-c3e5-4071-9382-a4b6d8f02142",
  "timestamp": "2026-07-20T12:30:45.045Z",
  "type": "log",
  "level": "info",
  "message": "GET /api/orders/:id -> 200 (45ms)",
  "service_id": "00000000-0000-0000-0000-000000000000",
  "service": { "name": "orders-api", "version": "1.4.2", "environment": "production" },
  "trace": { "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7" },
  "metadata": {
    "http": {
      "method": "GET",
      "route": "/api/orders/:id",
      "url": "/api/orders/123",
      "status_code": 200,
      "duration_ms": 45,
      "scheme": "https",
      "client": {
        "address": "203.0.113.10"
      },
      "user_agent.original": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    "correlation": { "requestId": "req-abc", "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }
  }
}
```

#### G) Span payload (`POST /v1/spans`)

v4 spans use `duration_us` (**microseconds**, not `duration_ms`) and a `status` enum
(`unset`/`ok`/`error`) — there is no `is_error` field on the wire; it is derived server-side from
`status`. `attributes` is where business/tag metadata that should show up as `metadata_json` in
the trace UI goes — see section 19.4 for how an active `withBusinessContext` scope merges into it
automatically, and when to still set it explicitly.

```json
{
  "spans": [
    {
      "span_timestamp": "2026-07-20T12:30:45.500Z",
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "span_id": "00f067aa0ba902b7",
      "parent_span_id": "b7ad6b7169203331",
      "service_id": "00000000-0000-0000-0000-000000000000",
      "service_name": "orders-api",
      "service_version": "1.2.3",
      "environment": "production",
      "span_name": "orders.insert",
      "span_type": "db",
      "start_time": "2026-07-20T12:30:45.350Z",
      "end_time": "2026-07-20T12:30:45.500Z",
      "duration_us": 150000,
      "status": "ok",
      "db_system": "sqlserver",
      "db_operation": "INSERT",
      "db_table": "orders",
      "attributes": { "entity": "order", "operation": "orders.create" }
    }
  ]
}
```

### 17.4 Payload quality checklist

Use the full operational checklist (P0/P1/P2, SQL validation, implementation log):

**[client-payload-quality-checklist.md](./client-payload-quality-checklist.md)**

Quick gate (minimum):

- [ ] Critical business flows include `entity`, `operation`, `result`, `impact`.
- [ ] Authenticated flows include `userId`, `accountId/orgId`, `role` (and `userEmail` only if policy allows).
- [ ] DB errors include `metadata.db` via `runQuery` (table/operation match the failing query).
- [ ] HTTP events include method/route template/status/duration, `scheme`, `client.address`, `user_agent.original`, and `metadata.correlation`.
- [ ] Errors include `metadata.correlation` and valid `metadata.http` (no `/unnormalized`, no `200` on server failure, no method in `route`).
- [ ] Spans are correlated, use stable names, and `service_id` matches the dashboard UUID.
- [ ] HTTP and DB spans on critical flows carry business `metadata_json`.
- [ ] No secrets or sensitive raw payloads are captured.

## 18) Keeping docs in sync (for maintainers)

When fixing payload issues in a client or in the platform:

1. Mark the item in [client-payload-quality-checklist.md](./client-payload-quality-checklist.md).
2. Update this playbook (sections 3, 10, 13, 17, 19, 20) if the guidance changes for **all future clients**.
3. Copy the same changes to the repo root `docs/client-installation-integration-playbook.md` and checklist when applicable.
4. Regenerate the client tarball (`artifacts/releases/`, current: `cc-stacktracer-1.2.0.tgz`) before handoff — check the directory for the actual latest file, this playbook will not stay in sync automatically.
5. Bump **both** `package.json` `version` and `SDK_VERSION` in `src/core/sdk-version.ts` — the
   latter is sent as `telemetry.sdk.version` on every event, and it silently drifted from `0.1.0`
   to a two-minor-version gap before 1.2.0 caught it.

### Revision note (2026-07-20)

This revision corrected several examples that had drifted from the current SDK/wire contract
(verified directly against `src/`, `packages/shared/schema/`, and `ingestion-api/src/` — not
assumed from prior doc text):

- All of §17.3's payload examples were on `schema_version: 3` and would be rejected by the ingest
  boundary today; rewritten to v4 (§17.1, §17.3, §20 already documented v4 but the examples had
  not been updated to match — this was tracked as pending item ERR-07 in the payload quality
  checklist).
- §6, §7, §10, §17.2, §19.4 described SDK usage patterns that do not match the actual API shape
  (`logStructured` has no `context` field, `captureException`'s second argument is already the
  context object, `withBusinessContext` only carries `entity`/`operation`/`fields_changed`, and
  spans never inherit business context). These were silent-failure bugs (no thrown error, just
  missing data on the wire) rather than typos — see the inline notes in each section.
- §5 previously described HMAC signing as something client stacks might add; it is built into the
  SDK transport and ingestion API already (`signIngestionRequest` / `IngestionSignatureService`)
  and should not be re-implemented.
- The §19.4 span/business-context gap and the missing generic `attributes` option on `runQuery`
  are real product gaps, not just doc bugs — worth a follow-up SDK change, not only a doc fix.

### Follow-up (2026-07-20, same day): the three SDK gaps below were fixed in code

The playbook revision earlier today flagged these as "known SDK gaps, not doc bugs." They are now
implemented (see `docs/superpowers/plans/2026-07-20-sdk-context-propagation-fixes.md`):

- `withBusinessContext(Async)` now auto-merges into span `attributes` (§19.4, §7).
- `runQuery`/`measure` accept a generic `attributes` option (§8, §19.4).
- The normalizer calls an optional `onDroppedContextKey` diagnostic hook — wired to
  `StackTrace.init({ logger })` — instead of silently discarding object/array values under
  unrecognized context keys (§20.5).

## 19) Integration quality defaults (mandatory before go-live)

This section consolidates recurring defects found in production integrations.
Treat it as a **hard gate**: new clients must satisfy every P0 item here before go-live.
The platform mitigates some route normalization and partial correlation, but **cannot**
substitute correct HTTP semantics, business metadata on spans, or real release identity.

### 19.1 Two telemetry planes (do not confuse them)

The dashboard exposes different views that read **different stores**:

| Surface | Data source | What it measures |
|---------|-------------|------------------|
| **Overview (`/dashboard`)** | `observability_spans` (HTTP spans) | Throughput (req/s), p95, Apdex, **application error rate (5xx / `is_error`)** |
| **Errors (`/errors`)** | `observability_errors` (`type: error` events) | Captured exceptions grouped by fingerprint |
| **Traces (`/traces`)** | Span tree per `trace_id` | End-to-end waterfall (HTTP → DB → children) |

Implications for integrators:

- Sending **only** `captureException` events populates `/errors` but leaves APM KPIs at zero
  if no HTTP spans are ingested.
- A **0% 5xx rate** on the overview is compatible with **non-zero error groups** in `/errors`
  when failures are validation exceptions, middleware aborts, or 4xx responses without 5xx.
- `/errors` group list is **retention-scoped**, not always equal to the selected time-range
  filter on the overview charts. Validate both planes independently.

### 19.2 Identity and release (ID-04, SP-05)

**Requirement:** every span and event must carry a meaningful `service_version` / `release`.

```ts
StackTrace.init({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  service: 'my-api', // optional display label
  release: process.env.GIT_SHA ?? process.env.npm_package_version ?? 'local-dev',
});
```

**Reject:**

- `service_version: "unknown"` (missing `release`)
- `service_version: "0.0.0"` when a real build identifier exists (package version or CI SHA)

**Validation (ClickHouse):**

```sql
SELECT
  any(service_version) AS version,
  countIf(service_version IN ('unknown', '', '0.0.0')) AS bad_version_rows,
  count() AS total
FROM observability_spans
WHERE service_id = {serviceId:UUID};
-- bad_version_rows must be 0 before go-live (or documented exception for local-only envs)
```

### 19.3 HTTP error payloads — real status, route template, duration (ERR-01…ERR-04)

Errors must describe the **HTTP response actually sent** (or about to be sent), not the
internal exception state.

#### Status and duration rules

| Scenario | `status_code` | `duration_ms` |
|----------|---------------|---------------|
| Validation failure (422/400) | **422 or 400** | elapsed since request start |
| Auth/tenant middleware abort (403/404) | **403 or 404** | elapsed since request start |
| Unhandled 500 | **500** | elapsed since request start |
| Failure inside active request | **never 200** | **never 0** when a request was received |

**Anti-pattern (reject in review):**

```json
"context": {
  "http": {
    "method": "POST",
    "route": "/api/items",
    "status_code": 200,
    "duration_ms": 24
  }
}
```

Message: `Validation failure` → must be `status_code: 422` (or your framework's real code).

**Anti-pattern — early middleware failure:**

```json
"context": {
  "http": {
    "method": "GET",
    "route": "GET /login",
    "status_code": 0,
    "duration_ms": 0
  }
}
```

See section 10 for the `captureHttpAwareException` helper pattern. Apply it in the global
exception handler, middleware catch paths, and any explicit `captureException` inside a request.

#### Correlation on every error and log (ERR-04, LOG-04)

`requestId` must be present under `metadata.correlation` on the wire (this is the `correlation`
argument you pass to `captureException`/`logStructured` — see section 10). The same value is
read back as `payload_json.context.correlation.requestId` in the persisted ClickHouse row
(`canonicalEventToErrorPayload`/`canonicalEventToLogPayload` project `metadata` into a `context`
block for the dashboard reader — that renaming happens server-side, not on the wire). It must be
present on:

- every HTTP access log
- every `captureException` inside a request
- every error re-thrown from middleware

Generate `requestId` once per request (or adopt inbound `x-request-id`) and store it on the
request object **before** any middleware that may fail.

**Validation:**

```sql
SELECT
  count() AS total,
  countIf(positionCaseInsensitive(payload_json, 'requestId') > 0) AS with_request_id
FROM observability_errors
WHERE service_id = {serviceId:UUID};
-- with_request_id / total must be 1.0 (100%) for HTTP-scoped errors
```

### 19.4 Business metadata on spans, not only on errors (SP-06)

A common defect: errors carry rich `operation` / `entity` tags while **all spans** have empty
`metadata_json`. That blocks drill-down from APM charts into domain context.

`withBusinessContext`/`withBusinessContextAsync` auto-merges `entity`/`operation`/`fields_changed`
into every span's `attributes` while the scope is active — `withSpan`, `startSpan`/`endSpan`, and
outbound (leaf) spans all pick it up, since they share one span-building function. Explicit
`attributes` on the call win on key collision.

**Requires SDK 1.2.0 or newer** — see `CHANGELOG.md` `[1.2.0]`. Verify what's actually installed
with `npm ls cc-stacktracer` before relying on it; on 1.1.0 and earlier, business context reaches
log/error events only and spans keep an empty `metadata_json`.

**Merge timing:** the merge is evaluated when the span *finalizes* — `fn()` resolving for
`withSpan`, `.end()` for `startSpan`/`endSpan`, `endOutboundSpan()` for outbound spans — not when
it starts. A manual `startSpan`/`endSpan` pair, or an outbound span, whose begin and end straddle
different `withBusinessContext` scopes picks up whatever context is active at the *end* call, not
what was active at the start. Every example below hides this because begin and end stay in one
continuous chain inside the scope.

```ts
await StackTrace.withBusinessContextAsync({ entity: 'invoice', operation: 'invoices.approve' }, async () => {
  await StackTrace.runQuery('postgres', 'invoices.update', () => db.query(updateSql), {
    table: 'invoices',
  });
  // the db span above now carries attributes: { entity: 'invoice', operation: 'invoices.approve' }
  // in metadata_json — no extra code needed at the call site.
});
```

`db_system`/`db_operation`/`db_table` (along with `http_method`/`http_route`/`http_status_code`/
`db_duration_ms`/`db_duration_us`/`trace_flags`) are always promoted to dedicated span columns —
they never appear in `metadata_json`, regardless of the business-context merge above. In the
example, the `db_table: 'invoices'` from `runQuery`'s `table` option lands in the span's own
`db_table` column, not in `attributes`.

`runQuery`/`measure` also accept an explicit `attributes` option (independent of business context)
for one-off span metadata that shouldn't apply to everything in scope:

```ts
await StackTrace.runQuery('postgres', 'invoices.update', () => db.query(updateSql), {
  table: 'invoices',
  attributes: { impact: 'financial' },
});
```

Minimum flows to wrap (adapt to your domain):

- authentication and session establishment
- create/update/delete on primary entities
- list/search endpoints with business impact
- background jobs that emit spans

**Validation:**

```sql
SELECT
  countIf(metadata_json IS NULL OR metadata_json IN ('', '{}')) AS empty_meta,
  count() AS total
FROM observability_spans
WHERE service_id = {serviceId:UUID}
  AND span_type = 'http';
-- empty_meta / total should trend to 0 on critical routes after go-live
```

### 19.5 Database span duration integrity (SP-08)

DB spans with `duration_ms = 0` while queries clearly ran destroy waterfall accuracy and
latency analysis.

**Causes (framework integrations):**

- span closed before query promise resolves
- ORM hook records start but not end on early return
- duration written only to `db_duration_ms` but not `duration_ms`

**Requirements:**

- close DB spans **after** the query/fetch completes (success or throw)
- ensure `duration_ms > 0` for queries that took measurable time
- keep stable semantic names: `{domain}.{table}.{operation}` (for example `billing.invoice.select`)

**Validation:**

```sql
SELECT
  countIf(duration_ms = 0) AS zero_duration,
  count() AS total,
  round(100.0 * zero_duration / total, 1) AS zero_pct
FROM observability_spans
WHERE service_id = {serviceId:UUID}
  AND span_type = 'db';
-- zero_pct should be < 10% under normal load; investigate if > 50%
```

**Trace shape sanity check:**

```sql
SELECT
  trace_id,
  count() AS spans,
  countIf(span_type = 'http') AS http,
  countIf(span_type = 'db') AS db
FROM observability_spans
WHERE service_id = {serviceId:UUID}
GROUP BY trace_id
ORDER BY spans DESC
LIMIT 20;
-- healthy HTTP request traces: http >= 1, db >= 1 on data-backed routes
```

### 19.6 HTTP span error semantics (`is_error`, OTel `status`) — P2 (SP-09)

HTTP spans should reflect failure status consistently:

| Response | Recommended span flags |
|----------|------------------------|
| 2xx success | `is_error = 0`, `status = ok` |
| 4xx client error | `is_error = 1` (or team policy for expected 404) |
| 5xx server error | `is_error = 1`, `status = error` |

Define a **team policy** for expected 4xx (for example 401 on missing token) vs abnormal 4xx.
Document exceptions so Apdex/error dashboards stay interpretable.

The overview **application error rate** primarily uses `http_status_code >= 500` and
`is_error = 1` without status; marking 4xx correctly still improves trace UI and alerts.

### 19.7 Security on error messages (SEC-01, SEC-02)

Do not embed tenant names, national IDs, e-mails, or tokens in `error.message` when an
opaque identifier suffices.

| Prefer | Avoid |
|--------|-------|
| `Tenant not found (tenant_id=…)` | `Tenant 'acme-corp' was not found` |
| `User not authorized` | `Login failed for user 'admin@company.com'` |

Put investigatable detail in structured, redacted business context — not in the exception
message surfaced to grouping.

### 19.8 Go-live validation script (minimum sample)

Execute after deploying instrumentation to a staging environment:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Successful GET on a data-backed route | HTTP span 2xx, ≥1 DB child, `parent_span_id` linked |
| 2 | Validation failure (POST invalid body) | Error event `status_code` 422/400, not 200 |
| 3 | Middleware/auth failure before controller | Error with real route template, status 4xx, `duration_ms > 0` |
| 4 | DB failure via `runQuery` | Error with `metadata.db`, DB span `is_error = 1` |
| 5 | Same `requestId` on log + error for one failed request | correlation match |

**ClickHouse acceptance queries** (replace `{serviceId:UUID}`):

```sql
-- HTTP routes: no method prefix, no unnormalized
SELECT countIf(
  span_type = 'http'
  AND (
    position(http_route, ' ') > 0
    OR http_route = '/unnormalized'
    OR match(http_route, '[0-9a-f]{8}-[0-9a-f]{4}-')
  )
) AS bad_routes
FROM observability_spans
WHERE service_id = {serviceId:UUID};

-- Errors: no 200 on validation-type messages (heuristic)
SELECT countIf(
  positionCaseInsensitive(payload_json, 'Validation') > 0
  AND positionCaseInsensitive(payload_json, '"status_code":200') > 0
) AS validation_with_200
FROM observability_errors
WHERE service_id = {serviceId:UUID};
```

All P0 counters above must be **zero** before production go-live.

## 20) Payload field reference (implementers)

Authoritative wire contracts:

- Events: `packages/shared/schema/canonical-event-v4.schema.ts`, `docs/contracts/payload-v4.md`
- Spans: `packages/shared/schema/span-v4.schema.ts`
- Metadata sub-schemas: `packages/shared/schema/metadata.schema.ts`, `http.schema.ts`, `db.schema.ts`, `business.schema.ts`

This section documents **every field the platform accepts** at ingest and how it is used after persistence.
For a didactic introduction aimed at SDK users, see [README — Understanding payloads](../README.md#understanding-payloads--field-by-field-v4).

### 20.1 Ingest endpoints and storage mapping

| Endpoint | Batch envelope | ClickHouse destination | Primary dashboard surfaces |
|----------|----------------|------------------------|---------------------------|
| `POST /v1/events` | `{ "events": EventV4[] }` | `observability_logs` or `observability_errors` | Explorer, `/errors`, trace detail logs |
| `POST /v1/spans` | `{ "spans": SpanV4Row[] }` (1–500) | `observability_spans` | `/dashboard` APM, `/traces`, `/performance` |

**Server-injected / derived fields (never send from SDK):**

| Field | Where | Source |
|-------|-------|--------|
| `tenant_id`, `project_id` | events, spans | API key scope at ingest |
| `service_name` (persisted) | logs, errors, spans | PostgreSQL `services.name` for `service_id` |
| `metadata.ingestion` | events | `enrichCanonicalEvent()` on ingestion API |
| `fingerprint_hex` | errors | worker hash of error shape |
| `is_noise` | spans | noise classifier from service settings |
| `duration_ms`, `db_duration_ms` | spans | derived from `duration_us`, `db_duration_us` |
| `is_error` (UInt8) | spans | derived from `status === 'error'` |
| `metadata_json` | spans | `JSON.stringify(attributes)` |
| `ingest_stream_id`, `inserted_at` | all | queue + ClickHouse insert time |

### 20.2 EventV4 — top-level (`POST /v1/events`)

Strict object — unknown top-level keys are rejected.

| Field | Type | Owner | Description | Implementation notes |
|-------|------|-------|-------------|----------------------|
| `schema_version` | `4` | Client | Wire contract version | `parseIngestEventStrictV4` rejects any other value (400). |
| `service_id` | UUID | Client | Canonical service identity | Must match dashboard `/services` and API key scope. |
| `tenant_id` | UUID? | Server | Organization/tenant scope | Injected from API key; client value must match if sent. |
| `project_id` | UUID? | Server | Project scope | Injected from API key; client value must match if sent. |
| `event_id` | UUID | Client | Idempotency key | Client-generated; dedup on replay. |
| `timestamp` | ISO-8601 | Client | Event time at source | `client_timestamp` in ClickHouse. |
| `type` | `log` \| `error` | Client | Routing discriminator | `error` → error stream; `log` → log stream. No `performance` in v4. |
| `level` | enum | Client | Severity | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `message` | string 1–64000 | Client | Human-readable summary | Search, group titles; avoid PII when possible. |
| `service` | object | Client | Deploy labels | See §20.3. |
| `trace` | object | Client | W3C trace correlation | See §20.4. Required on every event. |
| `metadata` | object | Client (+ server `ingestion`) | Structured context | See §20.5. Defaults to `{}`. |
| `error` | object? | Client | Typed exception | Required when `type: error`. See §20.6. |

### 20.3 Event `service` block

| Field | Type | Description | Persistence |
|-------|------|-------------|-------------|
| `name` | string 1–256 | Logical service label | Display; overwritten by dashboard registry name on persist. |
| `version` | string ≤256 | Release/build id | `service_version` column; reject `unknown` / placeholder `0.0.0` when real release exists. |
| `environment` | string 1–256 | Deploy slice | `environment` column; filters and capture policy. |

### 20.4 Event `trace` block

W3C trace-context hex (not UUID strings).

| Field | Type | Description | Implementation notes |
|-------|------|-------------|----------------------|
| `trace_id` | 32 lowercase hex | Distributed trace id | Must align with `traceparent` and span `trace_id`. |
| `span_id` | 16 lowercase hex | Active span when event emitted | Links event node in trace detail. |
| `parent_span_id` | 16 hex? | Parent span | Optional; builds hierarchy with spans. |

### 20.5 Event `metadata` sub-blocks

Defined in `MetadataSchema` (strict — only listed keys allowed).

#### `metadata.http`

| Field | Type | Description | Validation / usage |
|-------|------|-------------|-------------------|
| `method` | string 1–32 | HTTP verb | Promoted to `http_method` on logs. |
| `route` | string 1–2048 | **Route template** | Low-cardinality grouping; rejects raw numeric/UUID segments in route. |
| `url` | string ≤8192? | Concrete URL | Debug only; prefer `route` for analytics. |
| `status_code` | int | HTTP response status | Must reflect real response on errors (not `200` on failure). |
| `duration_ms` | number ≥0 | Request duration | Apdex/latency correlation on error events. |
| `scheme` | string? | `http` / `https` | Security and environment context. |
| `client.address` | string? | Client IP | Optional attribution. |
| `user_agent.original` | string? | User-Agent header | Client diagnostics. |

#### `metadata.db`

| Field | Type | Description |
|-------|------|-------------|
| `system` | string | DB engine (`postgres`, `sqlserver`, `mysql`, …) |
| `operation` | string | Verb (`SELECT`, `INSERT`, …) |
| `table` | string | Table/collection name |
| `duration_ms` | number ≥0 | Query duration |
| `statement` | string ≤500? | Truncated SQL (no secrets) |
| `rows` | int? | Rows read/affected |

Populated automatically when using `runQuery`; manual `captureException` should set when DB failed.

#### `metadata.business`

| Field | Type | Description |
|-------|------|-------------|
| `entity` | string | Domain entity (`order`, `invoice`, …) |
| `operation` | string | Stable operation id (`orders.approve`) |
| `fields_changed` | string[]? | Changed field names |
| `user_id` | string? | Actor id (opaque) |

Use `withBusinessContext` so nested logs/errors inherit `entity`/`operation`/`fields_changed`.
**This is the full field set** (`BusinessSchema` — no `.strict()`, so unknown keys are silently
stripped, not rejected). `userId`/`accountId`/`role`/`userEmail`/`result`/`impact` do **not**
belong here — see the tag-promotion note below and section 7.

#### `metadata.correlation`

| Field | Aliases | Description |
|-------|---------|-------------|
| Request id | `requestId`, `request_id` | Application request id (`x-request-id`) |
| Trace mirrors | `traceId`/`trace_id`, `spanId`/`span_id`, `parentSpanId`/`parent_span_id` | Optional bridges; canonical trace is top-level `trace` |

**Requirement:** every HTTP-scoped log and error must include `requestId` (see §19.3).

#### `metadata.tags`

`Record<string, string>` — low-cardinality facets (`component`, `driverCode`, …). **Values must
be strings**; numbers/booleans are coerced to string by the SDK before this point, but do not
rely on that — send strings.

**Auto-promotion mechanism (undocumented elsewhere, used by every business-identity example in
this playbook):** the SDK-level `context`/`attributes` object passed to `captureException` /
`log` / `logStructured` is not sent as-is. `structureMetadataFromV1Event` (SDK normalizer) walks
its top-level keys; anything matching a structured block name (`http`, `db`, `business`,
`correlation`, `queue`, …) is parsed against that block's schema, and every **other** key whose
value is a string/number/boolean is copied into `metadata.tags` (object/array values with no
matching block are silently dropped). This is exactly how `userId`/`accountId`/`role` reach
ClickHouse today — they are not a `business` field, they are a promoted tag. Object/array values
under an unrecognized key trigger a dev-diagnostic warning (via `StackTrace.init({ logger })`)
instead of a silent drop — wire a `logger.warn` in non-production environments to catch this class
of mistake automatically. **Requires SDK 1.2.0 or newer** — see `CHANGELOG.md` `[1.2.0]`; verify
with `npm ls cc-stacktracer`.

#### `metadata.runtime`

| Field | Description |
|-------|-------------|
| `node_version` | Node.js version |
| `platform` | OS platform |
| `arch` | CPU architecture |

#### `metadata.resource`

| Field | Description |
|-------|-------------|
| `name` | Resource name (OTel-style) |
| `type` | Resource type |

#### `metadata.queue`

| Field | Description |
|-------|-------------|
| `name` | Queue name |
| `duration_ms` | Time in queue |

#### `metadata.ingestion` (server-merged)

| Field | Set by | Description |
|-------|--------|-------------|
| `region` | Ingestion API | Collector region label |
| `ingested_at` | Ingestion API | ISO timestamp when accepted |
| `environment` | Ingestion API | Collector `NODE_ENV` |
| `server.hostname` | Ingestion API | Ingestion host |

#### Capture policy flags

| Field | Description |
|-------|-------------|
| `critical` / `capture_critical` | When `true`, bypasses sampling (subject to master `enabled`) |

### 20.6 Event `error` block (`type: error`)

| Field | Type | Description |
|-------|------|-------------|
| `type` | string 1–512 | Exception class name → `error_name` column |
| `message` | string 1–16000 | Exception message |
| `stack` | string ≤512000? | Stack trace (sanitized server-side when configured) |

Worker projection (`canonicalEventToErrorPayload`): top-level `message`, `name`, `stack`; remaining metadata → `payload_json.context`.

### 20.7 ClickHouse columns — `observability_logs`

| Column | Source field | Query usage |
|--------|--------------|-------------|
| `tenant_id`, `project_id`, `service_id` | API key + event | Tenant isolation |
| `service_name` | Postgres registry | Display |
| `service_version` | `service.version` | Release filters |
| `environment` | `service.environment` | Environment filter |
| `event_id` | `event_id` | Idempotency |
| `received_at` | Server clock | Ingest timeline |
| `client_timestamp` | `timestamp` | Client event time |
| `level` | `level` | Severity filters |
| `message` | `message` | Full-text search |
| `trace_id` | `trace.trace_id` | Trace join |
| `request_id` | `metadata.correlation` | Request correlation |
| `http_method`, `http_route`, `http_status_code` | `metadata.http` | HTTP analytics on logs |
| `metadata_json` | projected log payload | Explorer raw JSON |
| `ingest_stream_id` | Queue message id | Dedup |
| `inserted_at` | Insert time | Lag metrics |

### 20.8 ClickHouse columns — `observability_errors`

| Column | Source | Query usage |
|--------|--------|-------------|
| `fingerprint_hex` | Worker hash | **Error group key** on `/errors` |
| `error_name` | `error.type` | Classification filters |
| `message`, `stack` | Event / error block | Group title and detail drawer |
| `trace_id` | `trace` | Link to trace |
| `payload_json` | `canonicalEventToErrorPayload` | Dashboard reads `context` for http/db/correlation |
| Other scope columns | Same as logs | Tenant, service, timestamps |

### 20.9 SpanV4Row — wire (`POST /v1/spans`)

Source: `spanV4RowSchema`. Batch: 1–500 spans per request.

#### Identity and scope

| Field | Type | Owner | Description |
|-------|------|-------|-------------|
| `service_id` | UUID | Client | Canonical service (required) |
| `tenant_id` | UUID? | Client/server | Validated against stream envelope |
| `project_id` | UUID? | Client/server | Validated against stream envelope |
| `service_name` | string? | Client | Ignored for analytics; registry name used on persist |
| `service_version` | string? | Client | Release tracking |
| `environment` | string? | Client | Environment slice |

#### Trace and timing

| Field | Type | Description |
|-------|------|-------------|
| `trace_id` | string | Trace id (SDK: W3C 32-hex) |
| `span_id` | string | Span id (SDK: W3C 16-hex) |
| `parent_span_id` | string? | Parent span id; `null` for trace roots |
| `span_timestamp` | ISO | Representative timestamp → CH `timestamp` partition key |
| `start_time` | ISO | Span start |
| `end_time` | ISO | Span end |
| `duration_us` | int ≥0 | **Canonical duration** (microseconds) |

#### Semantics

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `span_name` | string? | e.g. `GET /orders`, `billing.invoice.select` | UI label in waterfall |
| `span_type` | enum? | `http`, `db`, `business`, `service`, `external` | Dashboard breakdowns (req/s uses `http`) |
| `status` | enum | `unset`, `ok`, `error` | OTel status; `error` → `is_error=1` |

#### HTTP fields (`span_type: http`)

| Field | Description | Dashboard impact |
|-------|-------------|------------------|
| `http_method` | HTTP verb | Throughput by method |
| `http_route` | Route template | **Req/s, p95, top routes** on overview |
| `http_status_code` | 100–599 | Error rate (5xx), Apdex |

#### DB fields (`span_type: db`)

| Field | Description |
|-------|-------------|
| `db_system` | Engine name |
| `db_operation` | SQL verb |
| `db_table` | Table name |
| `db_duration_us` | Query-only duration (µs) → `db_duration_ms` |

#### Error on span

| Field | Description |
|-------|-------------|
| `error_type` | Error class on failed span |
| `error_message` | Short error text |

#### Extensions

| Field | Type | Description |
|-------|------|-------------|
| `trace_flags` | string? | W3C trace flags |
| `attributes` | `Record<string, unknown>`? | Free-form metadata → `metadata_json` in ClickHouse |

**Implementers:** an active `withBusinessContext`/`withBusinessContextAsync` scope now merges
`entity`/`operation`/`fields_changed` into this field automatically — no manual propagation
needed. Set it explicitly only for span-specific metadata that isn't business context (see
section 19.4).

### 20.10 Span persistence derivations

| Wire field | ClickHouse column | Rule |
|------------|-------------------|------|
| `duration_us` | `duration_ms` | `round(duration_us / 1000)` |
| `db_duration_us` | `db_duration_ms` | `round(db_duration_us / 1000)` |
| `status` | `is_error` | `1` if `status === 'error'` |
| `attributes` | `metadata_json` | `JSON.stringify` or null |
| — | `is_noise` | `isNoiseForSpan()` from service settings |
| — | `service_name` | Resolved from Postgres, not client payload |

### 20.11 Mental model — which payload powers which KPI

| Product need | Minimum payload |
|--------------|-----------------|
| Overview throughput / p95 / Apdex | HTTP spans with `http_route`, `http_status_code`, `duration_us` |
| `/errors` groups | `type: error` events with `error` block + valid `metadata.http` when in-request |
| Trace waterfall | Spans with consistent `trace_id` and `parent_span_id` chain |
| “Who did what?” | `metadata.business` + `metadata.correlation.requestId` |
| “Which deploy broke?” | `service.version` / `service_version` with real `release` in `init` |
| DB slow paths | `span_type: db` with `duration_us > 0` and `db_*` fields |

### 20.12 Validation entry points (code references)

| Layer | Function / schema |
|-------|-------------------|
| Event ingest | `parseIngestEventStrictV4` → `EventSchemaV4` |
| Span ingest | `v1SpansBatchSchema` / `spanV4RowSchema` |
| HTTP route quality | `HttpSchema` + `routeHasRawDynamicSegments` |
| Error payload projection | `canonicalEventToErrorPayload`, `canonicalEventToLogPayload` |
| Span → ClickHouse | `mapSpanToClickHouseRow` in `clickhouse-span-writer.ts` |
| Log → ClickHouse | `clickhouse-log-writer.ts` (`extractRequestId`, `extractHttpRoute`) |
| Error → ClickHouse | `mapErrorToClickHouseRow` in `clickhouse-error-writer.ts` |
