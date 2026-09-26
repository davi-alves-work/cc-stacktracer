/**
 * Faixas de status HTTP que contam como erro, no formato do Datadog (`DD_TRACE_HTTP_SERVER_ERROR_STATUSES`
 * e `DD_TRACE_HTTP_CLIENT_ERROR_STATUSES`): codigos ou faixas de 100 a 599 separados por virgula, com
 * espacos ignorados — ex.: "500-599,429". Conferido em dd-trace-js `status-validator.js` (2026-09-25).
 */
export type HttpErrorStatusPredicate = (code: number) => boolean;

const RANGES_PATTERN = /^[1-5]\d{2}(?:-[1-5]\d{2})?(?:,[1-5]\d{2}(?:-[1-5]\d{2})?)*$/;
const MAX_STATUS = 599;

export const DEFAULT_HTTP_SERVER_ERROR_STATUSES = '500-599';
/**
 * O Datadog usa 400-499 para chamada de SAIDA. Aqui fica 500-599: na plataforma, a falha de qualquer span
 * reprova a requisicao, e um 404 de API externa ("isso existe?") nao pode reprovar a requisicao do cliente.
 */
export const DEFAULT_HTTP_CLIENT_ERROR_STATUSES = '500-599';
export const HTTP_STATUS_RANGES_HINT = 'codes or ranges from 100 to 599, comma separated (e.g. "500-599,429")';

export function isValidHttpErrorStatuses(ranges: string): boolean {
  return RANGES_PATTERN.test(ranges.replace(/\s/g, ''));
}

export function parseHttpErrorStatuses(ranges: string): HttpErrorStatusPredicate {
  const normalized = ranges.replace(/\s/g, '');
  if (!RANGES_PATTERN.test(normalized)) {
    throw new Error(`invalid HTTP status ranges "${ranges}": use ${HTTP_STATUS_RANGES_HINT}`);
  }
  const errorCodes = new Uint8Array(MAX_STATUS + 1);
  for (const part of normalized.split(',')) {
    const dash = part.indexOf('-');
    if (dash === -1) {
      errorCodes[Number(part)] = 1;
      continue;
    }
    const a = Number(part.slice(0, dash));
    const b = Number(part.slice(dash + 1));
    errorCodes.fill(1, Math.min(a, b), Math.max(a, b) + 1);
  }
  return (code) => Number.isInteger(code) && code >= 0 && code <= MAX_STATUS && errorCodes[code] === 1;
}

/** Opcao do `init` vence a env; env invalida vira aviso e o padrao vale (o que o Datadog faz). */
export function resolveHttpErrorStatuses(params: {
  option: string | undefined;
  envValue: string | undefined;
  envName: string;
  fallback: string;
  warn: (message: string) => void;
}): HttpErrorStatusPredicate {
  if (params.option !== undefined) {
    return parseHttpErrorStatuses(params.option);
  }
  const env = params.envValue;
  if (env !== undefined && env.trim() !== '') {
    if (isValidHttpErrorStatuses(env)) {
      return parseHttpErrorStatuses(env);
    }
    params.warn(
      `cc-stacktracer: ${params.envName}="${env}" is invalid — use ${HTTP_STATUS_RANGES_HINT}. Using ${params.fallback}.`,
    );
  }
  return parseHttpErrorStatuses(params.fallback);
}
