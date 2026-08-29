/**
 * Códigos de check da auditoria de instrumentação — o **contrato** entre quem os emite
 * (`buildInstrumentationAudit`), quem os transporta (o campo `notices` da capture policy V2) e os
 * quatro renderizadores: a tela de serviços, o prompt do Stacky, o CLI `doctor` e o log de boot do
 * SDK.
 *
 * ## A frase nunca viaja
 *
 * Só o código e os `params` cruzam a rede. Cada consumidor renderiza no idioma dele — a tela em
 * pt-BR/en-US pelo locale do usuário, o Stacky em pt-BR, o CLI e o log do SDK em inglês. Deixar o
 * servidor mandar texto pronto para o terminal do cliente seria superfície ruim e resolveria o
 * idioma errado.
 *
 * ## Por que aqui, e não em `packages/core` junto do audit
 *
 * `packages/shared` é o fundo do grafo: só depende de `zod`, todo mundo depende dele, e é o pacote
 * que já tem cópia vendorizada em `src/shared/schema/` — a forma como o SDK lê qualquer coisa de
 * `packages/` sem violar `src/packaging/client-package.test.ts`, que exige zero dependências
 * `@cc-stacktracer/*` no pacote publicado.
 *
 * **Mantenha as duas cópias idênticas** (`packages/shared/schema/` e `src/shared/schema/`); há
 * guard de sincronia em `packages/shared/schema/vendored-copies.test.ts`.
 */

export const INSTRUMENTATION_CHECKS = [
  /** Serviço existe mas nunca enviou nada — o aviso mais útil no boot do SDK. */
  'no_data',
  /** Enviava e parou: sem evento novo além do limiar de silêncio. */
  'silent',
  /** Logs chegam, spans não — sem traces nem APM. */
  'spans_missing',
  /** Há spans, mas nenhum HTTP — sem req/s, p95 e Apdex. */
  'http_spans_missing',
  /** Spans sem `service_version` — cego para comparar deploys. */
  'service_version_missing',
  /** Sem `environment` — produção e staging no mesmo balde. */
  'environment_missing',
  /** Nenhum span de negócio — sem "quem fez o quê". */
  'business_spans_missing',
  /** Rotas com id cru (`/users/42`) em vez de template — cardinalidade alta. */
  'route_cardinality',
  /** Subtenants demais: o campo provavelmente recebeu id de usuário ou de requisição. */
  'subtenant_cardinality',
  /** Nada a corrigir. É finding de verdade, com severidade `ok` — não a ausência de findings. */
  'ok',
] as const;

export type InstrumentationCheck = (typeof INSTRUMENTATION_CHECKS)[number];

/**
 * Severidade de um finding. `ok` é valor legítimo e não pode faltar em nenhum enum de wire: o
 * finding `ok` o usa, e um elemento inválido reprova o array INTEIRO no `zod` — um único código
 * fora do contrato apagaria todos os avisos daquele ciclo, em silêncio.
 */
export const INSTRUMENTATION_SEVERITIES = ['ok', 'warn', 'fail'] as const;

export type InstrumentationSeverity = (typeof INSTRUMENTATION_SEVERITIES)[number];
