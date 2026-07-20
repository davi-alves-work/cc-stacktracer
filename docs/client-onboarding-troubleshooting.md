# Client onboarding troubleshooting

Use this checklist when a new client is not sending data correctly.

## Fast path

1. Confirm the service exists in `/services`.
2. Confirm the client uses the service UUID as `STACKTRACE_SERVICE_ID`.
3. Confirm the API key belongs to the target project and is not revoked.
4. Confirm `STACKTRACE_ENDPOINT` is the base URL, without `/v1/events` or `/v1/spans`.
5. Send one log before instrumenting HTTP and database spans.
6. Check ingestion responses before checking the dashboard.

## Common failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401` or `403` | Invalid, revoked, or wrong-project API key | Generate a new ingestion key |
| `400` | Payload does not match schema | Compare with `docs/client-universal-https-ingestion.md` |
| `413` | Payload is too large | Truncate metadata and avoid request bodies |
| `503` | Ingestion dependency unavailable | Retry with backoff and do not block user requests |
| Data appears under wrong service | Wrong `service_id` | Copy UUID from `/services` |
| No trace waterfall | Missing or inconsistent `trace_id` | Reuse one `trace_id` per request |
| DB spans appear detached | Missing `parent_span_id` | Point child spans to the current parent span |
| Routes explode in cardinality | Raw IDs in route | Use `/resource/:id` style route labels |
| Secrets appear in payload | Metadata or headers not redacted | Redact before sending |

## Support evidence to collect

- Ingestion URL used by the client, without secrets.
- HTTP status code returned by ingestion.
- One redacted request payload.
- Service id used by the client.
- Timestamp range checked in the dashboard.
- Whether the client is Node.js `.tgz` or universal HTTPS.

Never ask the client to paste raw API keys, cookies, bearer tokens, passwords, full SQL with values, or request bodies containing personal data.
