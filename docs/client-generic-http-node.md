# Generic HTTP integration for Node.js

Use `cc-stacktracer/generic-http` when the client uses Node.js but does not use one of the official framework integrations.

## Minimal pattern

```ts
import { StackTraceHttpRequest } from 'cc-stacktracer/generic-http';

const trace = StackTraceHttpRequest.start({
  method: request.method,
  url: request.url,
  route: '/clientes/:id',
  headers: request.headers,
});

try {
  const result = await trace.run(async () => {
    return await handler(request);
  });

  trace.end({ statusCode: 200 });
  return result;
} catch (error) {
  trace.end({ statusCode: 500, error: error as Error });
  throw error;
}
```

## What this creates

- one HTTP request event with `metadata.http`;
- one root HTTP span;
- shared `trace_id` between the event and span;
- root span id as the event `span_id`;
- a trace context for child spans created with `StackTrace.withSpan` or `StackTrace.runQuery`.

## Rules

- Prefer route templates such as `/clientes/:id`.
- Do not use raw URLs with IDs as route labels.
- Redact request bodies, tokens, cookies, passwords, SQL, and personal data before adding custom metadata.
- Telemetry must not block user requests when ingestion is unavailable.
