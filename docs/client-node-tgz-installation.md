# Client Node.js installation with one `.tgz`

Use this path when the client application runs on Node.js and can install npm packages.

## Install

```bash
npm install ./artifacts/releases/cc-stacktracer-1.0.0.tgz
```

Only this tarball is required. Do not install `@cc-stacktracer/shared`, `@cc-stacktracer/db-prisma`, `@cc-stacktracer/db-lucid`, `@cc-stacktracer/http-fastify`, or `@cc-stacktracer/http-adonis`.

## Configure

```env
STACKTRACE_API_KEY=
STACKTRACE_SERVICE_ID=00000000-0000-0000-0000-000000000000
STACKTRACE_ENDPOINT=https://ingest.example.com
```

`STACKTRACE_ENDPOINT` is the base URL. Do not append `/v1/events`, `/v1/spans`, `/ingest/error`, or `/ingest/log`.

## Initialize

```ts
import { StackTrace } from 'cc-stacktracer';

StackTrace.init({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
});
```

## Optional integrations

- Fastify: `cc-stacktracer/fastify`
- Express: `cc-stacktracer/express`
- AdonisJS: `cc-stacktracer/adonis`
- Prisma: `cc-stacktracer/db-prisma`
- Lucid/Knex: `cc-stacktracer/db-lucid`
- Custom HTTP frameworks: `cc-stacktracer/generic-http`

Framework packages are optional peer dependencies. A client that does not use Prisma, Lucid, Fastify, Express, or AdonisJS does not need to install them.

## Distributed tracing (optional)

Incoming `traceparent` is adopted automatically (the root span links to its upstream caller).
**Outbound** propagation — instrumenting the HTTP calls *this* service makes so downstream
services join the same trace — is opt-in:

```ts
StackTrace.auto({
  outboundHttp: { instrumentFetch: true, instrumentNodeHttp: true },
});
```

`instrumentNodeHttp` covers libraries that go through Node's `http`/`https` (axios, got,
follow-redirects). The SDK never traces its own calls to `STACKTRACE_ENDPOINT`. Full guide,
options, and validation steps: [client-distributed-tracing.md](./client-distributed-tracing.md).
