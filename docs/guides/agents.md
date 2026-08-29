# cc-stacktracer — rules for coding agents

Neutral instructions for any coding assistant (Claude Code, Copilot, Cursor, Windsurf, Codex)
integrating the `cc-stacktracer` SDK into a Node.js application.

**Read this before writing integration code.** Every rule below exists because getting it wrong
produces telemetry that looks fine and is wrong.

## 1. Install and configure

```bash
npm install cc-stacktracer
```

Exactly three environment variables. Do not invent a fourth.

```bash
STACKTRACE_API_KEY=sk_...          # project ingestion key (x-api-key header)
STACKTRACE_SERVICE_ID=<uuid>       # stable service UUID, copied from the dashboard at /services
STACKTRACE_ENDPOINT=https://...    # ingestion API base URL, no path
```

`STACKTRACE_SERVICE` and `STACKTRACE_ENVIRONMENT` are **not** variables. The SDK derives those
labels; adding them to an `.env` teaches the developer something false.

## 2. `serviceId` is the identity; `service.name` is a label

`service_id` travels on every event and span and is what grouping, filters, SLOs and multi-tenant
scoping key on. It must already exist in the dashboard — the SDK does not create services.
`service.name` is a display label and can be renamed without changing anything.

## 3. `release` matters more than it looks

```ts
release: process.env.APP_VERSION ?? '1.0.0',
```

Without it there is no `service_version` on spans, and every "which deploy broke this?" question
becomes unanswerable. It is optional in the type and effectively required in practice.

## 4. Initialize once, at startup

Prefer `StackTrace.auto` — it calls `init`, wires Fastify/Prisma/Lucid and runs the plugin hooks in
the right order.

```ts
import Fastify from 'fastify';
import { StackTrace } from 'cc-stacktracer';

const app = Fastify();

await StackTrace.auto({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  release: process.env.APP_VERSION ?? '1.0.0',
  fastify: app, // omit for Express/Adonis and use their middleware instead
});
```

## 5. Database instrumentation, per stack

| Stack         | How                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------ |
| Prisma 5+     | `$extends` with `query.$allModels.$allOperations` — **not** `$use`, which Prisma 5 removed |
| Prisma 4      | `$use` middleware                                                                          |
| Lucid / Knex  | the `cc-stacktracer/db-lucid` subpath                                                      |
| anything else | wrap the queries that matter with `StackTrace.runQuery`                                    |

Without database spans there is no waterfall, and "the request is slow" has no answer.

## 6. User identity and multi-tenant

```ts
StackTrace.setUser({ id: user.id }); // after authentication succeeds
```

For an application serving many customers, `subtenant` is an **optional payload field** on each
send:

```ts
StackTrace.captureException(err, { subtenant: customer.slug });
StackTrace.log('order placed', { subtenant: customer.slug });
await StackTrace.withSpan('process-order', () => service.process(data), {
  attributes: { subtenant: customer.slug },
});
```

**There is no `withSubtenant()`, `setSubtenant()` or any scope API for this.** If you are about to
suggest one because a similar library has it, stop — it will fail at runtime. The field is a payload
field by design: in a real multi-tenant app the customer is only known after authentication.

Use a readable slug, never a UUID or a user id: the value is shown raw in filters, and high
cardinality trips the `subtenant_cardinality` audit check.

Note the argument order: `withSpan(name, fn, options)` — the function comes **before** the options.

## 7. The v4 contract

- `POST /v1/events` with `{ "events": [...] }` — types `log` and `error` only.
- `POST /v1/spans` with `{ "spans": [...] }`.
- `schema_version: 4`, snake_case, strict — an unknown top-level field is rejected with 400.
- Trace ids are W3C hex: `trace_id` 32 chars, `span_id`/`parent_span_id` 16.
- `tenant_id` and `project_id` belong to the server, derived from the API key. **Never send them.**

## 8. Verify with the doctor, and act on what it says

```bash
npx cc-stacktracer doctor --json
```

It reports, in order: detected stack, configuration, connectivity, a synthetic log + span through
the real ingestion path, and the instrumentation gaps the server sees. Exit code `0` means the
installation works.

Instrumentation findings do **not** fail the exit code — the installation works even with gaps —
but each one is a concrete thing to fix, and the JSON output exists so you can act on it without a
human reading the terminal.

Do not replicate the audit rules in application code: they live on the server, and a second copy
would start disagreeing with the dashboard.
