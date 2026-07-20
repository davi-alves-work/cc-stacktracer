# Universal HTTPS ingestion contract

Use this guide when the client does not run Node.js or cannot install npm packages.

Any language that can make HTTPS requests can send data to CC StackTrace by using the ingestion contract directly.

## Endpoints

```text
POST {STACKTRACE_ENDPOINT}/v1/events
POST {STACKTRACE_ENDPOINT}/v1/spans
```

## Required headers

```text
content-type: application/json
x-api-key: <STACKTRACE_API_KEY>
```

Never place the API key in the request body or logs.

## Required identity

Every event and span must include:

```json
{
  "service_id": "00000000-0000-0000-0000-000000000000"
}
```

Do not send `tenant_id` or `project_id` from new clients. The ingestion API resolves scope from `x-api-key`.

## First log

```json
{
  "events": [
    {
      "schema_version": 3,
      "event_id": "11111111-1111-4111-8111-111111111111",
      "timestamp": "2026-05-24T12:00:00.000Z",
      "type": "log",
      "level": "info",
      "message": "Servico iniciou",
      "service_id": "00000000-0000-0000-0000-000000000000",
      "metadata": {
        "source": "universal-https-smoke-test"
      }
    }
  ]
}
```

## First HTTP span

```json
{
  "spans": [
    {
      "span_timestamp": "2026-05-24T12:02:00.042Z",
      "trace_id": "cccccccccccccccccccccccccccccccc",
      "span_id": "dddddddddddddddd",
      "parent_span_id": null,
      "service_id": "00000000-0000-0000-0000-000000000000",
      "span_name": "GET /clientes/:id",
      "span_type": "http",
      "start_time": "2026-05-24T12:02:00.000Z",
      "end_time": "2026-05-24T12:02:00.042Z",
      "duration_ms": 42,
      "http_method": "GET",
      "http_route": "/clientes/:id",
      "http_status_code": 200,
      "is_error": false,
      "error_type": null,
      "error_message": null,
      "metadata": null
    }
  ]
}
```

## Correlation rules

- A request should have one `trace_id`.
- The root HTTP span has `parent_span_id: null`.
- Child spans reuse the same `trace_id`.
- Child spans set `parent_span_id` to the current parent span.
- HTTP events should use the same `trace_id` and root `span_id` as the root HTTP span.

## Operational rules

- Use UTC ISO-8601 timestamps.
- Use integer `duration_ms` values greater than or equal to zero.
- Use route templates such as `/clientes/:id`.
- Send telemetry asynchronously.
- Use timeout and retry with backoff.
- Redact tokens, cookies, passwords, SQL, request bodies, and personal data.
