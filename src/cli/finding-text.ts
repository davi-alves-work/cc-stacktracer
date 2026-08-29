/**
 * Texto dos findings de instrumentação **no terminal**, em inglês.
 *
 * ## Este é um dos quatro renderizadores, e isso está certo
 *
 * A tela de serviços renderiza pelo locale do usuário (pt-BR + en-US), o prompt do Stacky em pt-BR,
 * e este aqui — CLI `doctor` e log de boot do SDK — em inglês. São públicos e meios diferentes.
 *
 * O que é compartilhado entre todos é o **código** (`check`) e os `params`; a frase nunca viaja na
 * rede. Um renderizador único devolveria a frase no idioma errado para três dos quatro.
 *
 * O mapa é `Record<InstrumentationCheck, …>` de propósito: acrescentar um código ao contrato sem
 * escrever a frase aqui **não compila**, em vez de imprimir o código cru no terminal do dev.
 */
import type { InstrumentationCheck } from '../shared/schema/instrumentation-checks.js';

/** Os mesmos `params` que o servidor manda junto do código. */
export type FindingParams = Record<string, string | number>;

const FINDING_TEXT: Record<InstrumentationCheck, (p: FindingParams) => string> = {
  no_data: () => 'no events received yet — check the API key, serviceId and endpoint.',
  silent: (p) => `no new events for ${p.minutes} min — did it stop sending?`,
  spans_missing: () => 'sending logs but no spans — no traces and no APM (p95/Apdex).',
  http_spans_missing: () => 'has spans but no HTTP span — no req/s, p95 or Apdex on the overview.',
  service_version_missing: () => 'spans without service_version — blind when comparing deploys.',
  environment_missing: () => 'no environment — production and staging land in the same bucket.',
  business_spans_missing: () => 'no business spans — no "who did what" in the analyses.',
  route_cardinality: (p) =>
    `routes carrying raw ids (e.g. "${p.example}") across ${p.distinctRoutes} distinct routes — high cardinality; use a :id template.`,
  subtenant_cardinality: (p) =>
    `${p.distinctSubtenants} distinct subtenants — check whether the payload's \`subtenant\` field is receiving a user or request id.`,
  ok: () => 'no instrumentation gaps detected.',
};

/**
 * Código desconhecido devolve o próprio código.
 *
 * O tipo já impede isso em TypeScript; o fallback cobre o que o tipo não alcança — um servidor mais
 * novo que esta versão do SDK. Imprimir o código é pior que a frase e muito melhor que quebrar.
 */
export function renderFindingText(finding: { check: string; params?: FindingParams }): string {
  const render = FINDING_TEXT[finding.check as InstrumentationCheck];
  return render !== undefined ? render(finding.params ?? {}) : finding.check;
}

/** Prefixo dos avisos do servidor no log de boot — reconhecível e greppável. */
export const NOTICE_PREFIX = '[cc-stacktracer]';

/** Uma linha por aviso, com o guia citado quando o servidor mandou um. */
export function renderNoticeLine(notice: { check: string; params?: FindingParams; guide?: string }): string {
  const text = renderFindingText(notice);
  return notice.guide !== undefined && notice.guide !== ''
    ? `${NOTICE_PREFIX} ${text} (guide: ${notice.guide})`
    : `${NOTICE_PREFIX} ${text}`;
}
