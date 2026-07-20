# Checklist de qualidade de payload — integração cc-stacktracer

Checklist operacional derivado de auditoria real (projeto **holerite-web**, maio/2026).
Use em onboarding de novos clientes e em revisões periódicas da integração.

**Documento relacionado:** [client-installation-integration-playbook.md](./client-installation-integration-playbook.md) (gate de go-live: **§19**; referência de campos: **§20**)

**Introdução didática (README):** [Understanding payloads — field by field (v4)](../README.md#understanding-payloads--field-by-field-v4)

**Pacote cliente (SDK):** `artifacts/releases/cc-stacktracer-0.2.0/cc-stacktracer-0.2.0.tgz` — gerado após `npm run build` (maio/2026).

**Manutenção:** marque itens conforme implementação; atualize o playbook quando um problema recorrente for resolvido.

---

## Como usar

1. Trabalhe **primeiro** o grupo **A) Rodar no cliente** (app integradora).
2. Valide o grupo **B) Rodar no cc-stacktracer** (já implementado — ver tabela abaixo).
3. Marque **Status**: `[ ]` pendente · `[x]` feito · `[-]` não aplicável.
4. Valide com amostra real no banco (1 log, 1 error, 1 span HTTP, 1 span DB).
5. Go-live só com todos os **P0** do cliente `[x]` (plataforma P0 já `[x]`) e queries de aceite do playbook **§19.8**.

| Prioridade | Significado |
|------------|-------------|
| **P0** | Quebra triagem, agrupamento ou correlação |
| **P1** | Qualidade analítica e suporte |
| **P2** | Padronização e DX |

---

## A) Rodar no cliente (app integradora)

Responsável: time da aplicação (ex.: HoleriteWeb). Referência: playbook de instalação + este checklist.

> A plataforma **mitiga** rotas cruas e preenche correlation em parte dos casos (SDK ALS), mas **não substitui** template Fastify, status HTTP real no handler nem `release` no init.

### Identidade

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| ID-01 | P0 | `STACKTRACE_SERVICE_ID` = UUID do dashboard (`/services`) | Init com UUID válido | [ ] |
| ID-03 | P1 | `service` legível no `init` (ex.: `holerite-web`) | JSON não mostra só `service-ce3b46e5` | [ ] |
| ID-04 | P1 | `release` / `STACKTRACE_RELEASE` no init | Spans sem `service_version: "unknown"` nem `"0.0.0"` quando há build real | [ ] |
| ID-05 | P2 | Handoff: nome no dashboard pode mudar; histórico no mesmo `serviceId` | Doc interno | [ ] |

### Logs HTTP

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| LOG-01 | P0 | `metadata.http.route` = template (`:id`), não path cru | DB sem IDs numéricos/UUID em `route` | [ ] |
| LOG-02 | P0 | `method`, `status_code`, `duration_ms` coerentes | Amostra de log HTTP | [ ] |
| LOG-03 | P0 | `scheme`, `client.address`, `user_agent.original` quando disponíveis | Campos no payload v4 (`metadata.http`) | [ ] |
| LOG-04 | P0 | `metadata.correlation.requestId` = `x-request-id` da app | Mesmo ID no log e na resposta | [ ] |
| LOG-06 | P1 | URL sem PII desnecessária (matrícula em claro, etc.) | Preferir `route` + contexto opaco | [ ] |
| LOG-07 | P2 | `trace` alinhado entre topo do evento e `metadata.trace` | Sem traces fragmentados | [ ] |

### Erros

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| ERR-01 | P0 | Error **sem** `http.route: "/unnormalized"` | Template ou rota mascarada | [ ] |
| ERR-02 | P0 | `status_code` = status real da resposta (4xx/5xx) | Não `200` em falha | [ ] |
| ERR-03 | P0 | `duration_ms` > 0 quando houve request | Preenchido no error-handler | [ ] |
| ERR-04 | P0 | `metadata.correlation` no error = mesmo request do log | `requestId` presente | [ ] |
| ERR-05 | P1 | `metadata.db` = query que falhou (`table` / `operation`) | Coerente com mensagem SQL | [ ] |
| ERR-07 | P2 | Exemplos no playbook usam contrato v4 (`schema_version: 4`) | Docs alinhados | [x] |
| ERR-08 | P0 | `http.route` sem método embutido (`GET /x` → `/x`) | Amostra errors + falhas de middleware | [ ] |
| ERR-09 | P0 | Falhas de middleware com status/duração reais (não `0`) | Tenant/auth/session abort paths | [ ] |

**Anti-padrão (não enviar):**

```json
"http": { "route": "/unnormalized", "status_code": 200, "duration_ms": 0 }
```

**Alvo:**

```json
"http": {
  "method": "GET",
  "route": "/api/holerites/:matricula/indicadores",
  "status_code": 500,
  "duration_ms": 842
},
"correlation": { "requestId": "…" }
```

### Spans

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| SP-01 | P0 | `http_route` com `:param`, não ID cru | Tabela `spans` | [ ] |
| SP-02 | P0 | Span DB com nome semântico (`folha.recibo.*`) | Nome estável | [ ] |
| SP-03 | P0 | `trace_id` / `parent_span_id` ligam HTTP → filhos | Waterfall completo | [ ] |
| SP-05 | P1 | `service_version` ≠ `"unknown"` | `release` no init | [ ] |
| SP-06 | P1 | `metadata` de negócio em fluxos críticos | `metadata_json` útil nos spans HTTP/DB | [ ] |
| SP-07 | P2 | Span DB referencia rota HTTP (tag/metadata) | Drill-down request → query | [ ] |
| SP-08 | P1 | `duration_ms > 0` na maioria dos spans DB | `zero_pct < 10%` no ClickHouse | [ ] |
| SP-09 | P2 | HTTP 4xx/5xx com `is_error` coerente | Política documentada + amostra traces | [ ] |

### Dashboard (documentação cliente)

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| DASH-01 | P1 | Time integra sabe: overview = spans HTTP; `/errors` = eventos | Doc interno / playbook §19.1 | [ ] |

### Segurança

| ID | P | Item | Validação | Status |
|----|---|------|-----------|--------|
| SEC-01 | P0 | Sem API keys, tokens, cookies, senhas no payload | Revisão + redaction | [ ] |
| SEC-02 | P1 | PII só se política permitir | DPIA / playbook | [ ] |
| SEC-03 | P1 | Query strings sensíveis redigidas | Sem `token=` em URL | [ ] |

### Itens “Ambos” (cliente lidera documentação)

| ID | P | Item | Status |
|----|---|------|--------|
| LOG-05 | P1 | Documentar diferença `events.correlation_id` (ingest) vs `metadata.correlation.requestId` (app) | [ ] |

---

## B) Rodar no cc-stacktracer (SDK + ingestão + dashboard)

**Status geral (2026-05-27): implementado no repositório e no `cc-stacktracer-0.2.0.tgz`.**

Após pull/build: `npm run build` (SDK) e `npm run build:ingestion` (API/worker). Reinicie `dev:stack` ou redeploy para carregar o shared/SDK novos.

### Plataforma / ingestão

| ID | P | Item | Validação | Status | Implementação (referência) |
|----|---|------|-----------|--------|---------------------------|
| ID-02 | P0 | `service_id` canônico; `service_name` do cadastro no dashboard | Joins por UUID | [x] | `ingestion-api/src/services/service-resolver.ts` (`findServiceInProject`); persist usa `service.name` do Postgres |
| SP-04 | P0 | Spans/events: `service_name` resolvido no persist, não do payload | DB ≠ `service-ce3b46e5` | [x] | `ingestion-api/src/workers/persist-span-batch.ts` (`resolveSpanServices` → `serviceName` do cadastro); `persist-ingest-message.ts` (`serviceName: service.name`) |
| PLAT-01 | P0 | Schema v3: `metadata.http` com `scheme`, `client.address`, `user_agent.original` | Testes shared | [x] | `packages/shared/schema/http.schema.ts`; merge v1 em `normalize.ts` / `v1HttpToV3` |
| PLAT-02 | P0 | `metadata.correlation` preservado na normalização v1→v3 | Testes shared | [x] | `MetadataSchema.correlation`; `eventV1ToV3` + `v1MetadataToCorrelation`; teste `preserves metadata.correlation` em `event-v3.test.ts` |
| PLAT-03 | P0 | `pickV3HttpRoute`: mascara IDs crus; fallback por `url`; menos `/unnormalized` | Testes `event-v3` | [x] | `packages/shared/schema/route-validation.ts` (`maskDynamicRouteSegments`); `pickV3HttpRoute` em `normalize-event.ts` |
| PLAT-04 | P0 | SDK `mergeEventContext`: `correlation` + `response_status_code` do ALS HTTP | Erros em request Fastify | [x] | `src/core/request-context.ts` |
| PLAT-05 | P1 | SDK `sanitizeStackTrace` em errors | Stacks sem paths absolutos dev | [x] | `src/utils/sanitize-stack.ts`; `src/capture/build-error-event.ts` |
| PLAT-06 | P1 | `runQuery({ captureError: false })` | Cliente captura no handler | [x] | `src/performance/measure.ts` (`RunQueryOptions.captureError`) |

### O que a plataforma **não** resolve sozinha

| Cenário | Motivo |
|---------|--------|
| Error com `status_code: 200` em falha HTTP | Cliente deve passar status real no handler/monitor |
| `duration_ms: 0` com request longa | Cliente deve medir duração no error-handler |
| Rota ideal `/:param` do Fastify | Cliente deve enviar `routerPath` / template; plataforma só mascara IDs numéricos/UUID |
| `service_version: "unknown"` | Cliente deve setar `release` no `init` |
| `service_version: "0.0.0"` com build real disponível | Cliente deve setar `GIT_SHA` ou versão do pacote no `init` |
| `http.route` com método embutido (`GET /login`) | Cliente deve separar `method` e template de rota |
| `metadata_json` vazio em todos os spans | Cliente deve usar `withBusinessContext` nos fluxos críticos — a partir do SDK **1.2.0** isso popula os spans automaticamente (antes só enriquecia eventos de log/erro) |
| PII em URL / business context | Política e redaction no cliente |

### Validação ClickHouse (roteiro — pós-ingestão)

Substitua `{serviceId:UUID}` pelo UUID do serviço no dashboard (`/services`).

```sql
-- Último log
SELECT service_name, received_at, payload_json
FROM observability_logs
WHERE service_id = {serviceId:UUID}
ORDER BY received_at DESC
LIMIT 1;

-- Último erro
SELECT error_name, message, trace_id, payload_json
FROM observability_errors
WHERE service_id = {serviceId:UUID}
ORDER BY received_at DESC
LIMIT 1;

-- Amostra spans
SELECT
  span_type,
  span_name,
  http_route,
  http_status_code,
  duration_ms,
  service_version,
  parent_span_id,
  trace_id,
  metadata_json
FROM observability_spans
WHERE service_id = {serviceId:UUID}
ORDER BY timestamp DESC
LIMIT 10;

-- Saúde agregada
SELECT
  countIf(span_type = 'http') AS http_spans,
  countIf(span_type = 'db' AND duration_ms = 0) AS db_zero_duration,
  countIf(service_version IN ('unknown', '0.0.0', '')) AS bad_version,
  countIf(
    span_type = 'http'
    AND (position(http_route, ' ') > 0 OR http_route = '/unnormalized')
  ) AS bad_http_routes
FROM observability_spans
WHERE service_id = {serviceId:UUID};
```

**Legado (PostgreSQL — apenas ambientes antigos):**

```sql
SELECT l.metadata->'http' AS http, l.metadata->'correlation' AS correlation
FROM events e JOIN logs l ON l.event_id = e.id
WHERE e.event_type = 'log' ORDER BY e.received_at DESC LIMIT 1;

SELECT er.context->'http' AS http, er.context->'correlation' AS correlation
FROM events e JOIN errors er ON er.event_id = e.id
WHERE e.event_type = 'error' ORDER BY e.received_at DESC LIMIT 1;
```

**Critérios de aceite plataforma (pós-deploy):**

- [x] Spans: `service_name` = nome cadastrado no dashboard
- [x] Ingest aceita `metadata.http` com `scheme`, `client`, `user_agent.original`
- [x] Rotas com só IDs numéricos normalizadas para `:id` quando cliente não envia template
- [ ] End-to-end holerite-web: depende dos itens P0 da seção A

---

## Registro de implementação

| Data | Grupo | Item | Notas | Playbook |
|------|-------|------|-------|----------|
| 2026-05-27 | Plataforma | ID-02, SP-04 | Resolução `service_name` via Postgres | [ ] |
| 2026-05-27 | Plataforma | PLAT-01, PLAT-02 | Schema v3 HTTP + correlation | [ ] |
| 2026-05-27 | Plataforma | PLAT-03…06 | Máscara rota, ALS correlation, stack sanitize, `captureError` | [ ] |
| 2026-05-27 | Entrega | `.tgz` | `artifacts/releases/cc-stacktracer-0.2.0/cc-stacktracer-0.2.0.tgz` | [ ] |
| | Cliente | Seção A (P0) | HoleriteWeb — pendente | [ ] |

---

## Histórico

| Data | Notas |
|------|-------|
| 2026-05-27 | Checklist criado (auditoria holerite-web). |
| 2026-05-27 | Split cliente vs plataforma. |
| 2026-05-27 | Plataforma: implementação PLAT-01…06 + ID-02/SP-04; `.tgz` republicado; checklist atualizado com referências de código. |
| 2026-06-25 | Playbook §19 (integration quality defaults); checklist: ERR-08/09, SP-08/09, DASH-01; validação ClickHouse. |
