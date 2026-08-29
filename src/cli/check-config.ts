/**
 * Valida as três variáveis obrigatórias do SDK antes de qualquer chamada de rede.
 *
 * A ordem importa para o dev: config errada e conectividade quebrada produzem o mesmo sintoma
 * ("não chega nada"), e só uma delas se conserta sem sair do editor. Checar config primeiro
 * transforma metade dos chamados de suporte num `export` faltando.
 *
 * Função pura: recebe o ambiente, devolve o diagnóstico. Quem lê `process.env` é o entrypoint.
 */

export type ConfigKey = 'STACKTRACE_API_KEY' | 'STACKTRACE_SERVICE_ID' | 'STACKTRACE_ENDPOINT';

/**
 * `missing` cobre ausente e string vazia — `export STACKTRACE_API_KEY=` é o modo mais comum de
 * "configurei e não funciona", e um valor em branco não é diferente de não ter valor.
 */
export type ConfigProblemReason = 'missing' | 'not_uuid' | 'not_url';

export type ConfigProblem = {
  key: ConfigKey;
  reason: ConfigProblemReason;
};

export type ConfigCheckResult = {
  ok: boolean;
  problems: ConfigProblem[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ordem de relato: a mesma em que o dev preenche o `.env`. */
const REQUIRED_KEYS: readonly ConfigKey[] = ['STACKTRACE_API_KEY', 'STACKTRACE_SERVICE_ID', 'STACKTRACE_ENDPOINT'];

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Endpoint precisa ser URL absoluta com esquema http(s). `localhost:3000` é o erro clássico: parece
 * um endereço, mas o `URL` do Node lê `localhost` como protocolo e o fetch nunca sai.
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function checkConfig(env: Partial<Record<ConfigKey, string>>): ConfigCheckResult {
  const problems: ConfigProblem[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = env[key];
    if (!present(value)) {
      problems.push({ key, reason: 'missing' });
      continue;
    }
    // Formato só é cobrado depois da presença: dizer "não é uuid" sobre um valor ausente confunde.
    if (key === 'STACKTRACE_SERVICE_ID' && !UUID_RE.test(value.trim())) {
      problems.push({ key, reason: 'not_uuid' });
    }
    if (key === 'STACKTRACE_ENDPOINT' && !isHttpUrl(value.trim())) {
      problems.push({ key, reason: 'not_url' });
    }
  }

  return { ok: problems.length === 0, problems };
}
