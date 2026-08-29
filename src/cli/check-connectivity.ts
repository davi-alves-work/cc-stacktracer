/**
 * Testa conectividade **e** credencial numa chamada só, e distingue as causas.
 *
 * Hoje todas elas chegam ao suporte como "não funciona" — e cada uma tem correção diferente, em
 * lugares diferentes. O par de 404 é o ponto todo desta função: um culpa o `STACKTRACE_SERVICE_ID`,
 * o outro o `STACKTRACE_ENDPOINT`, e mandar o dev conferir o campo errado gasta o dia dele.
 */

export type ConnectivityReason =
  | 'invalid_api_key'
  | 'forbidden'
  /** 404 vindo da API: o host é uma ingestion-api, mas o `serviceId` não pertence a esta chave. */
  | 'service_not_found'
  /** 404 que não veio da API (HTML, corpo vazio): o host responde, mas não é uma ingestion-api. */
  | 'endpoint_not_found'
  | 'bad_service_id'
  | 'rate_limited'
  | 'server_unavailable'
  | 'dns_failure'
  | 'connection_refused'
  | 'timeout'
  | 'unexpected_status'
  | 'network_error';

export type ConnectivityResult = { ok: true } | { ok: false; reason: ConnectivityReason; status?: number };

export type ConnectivityInput = {
  endpoint: string;
  apiKey: string;
  serviceId: string;
};

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json?: () => Promise<unknown>;
}>;

/**
 * Um 404 da própria API traz `{ success: false }` em JSON; um 404 de proxy, CDN ou host errado traz
 * HTML ou corpo vazio. É a única evidência disponível para separar "serviço não existe" de
 * "endereço não é uma ingestion-api", e vale mais que adivinhar pelo host.
 */
async function classifyNotFound(res: Awaited<ReturnType<FetchLike>>): Promise<ConnectivityReason> {
  const contentType = res.headers?.get('content-type') ?? '';
  if (!contentType.includes('json') || res.json === undefined) {
    return 'endpoint_not_found';
  }
  try {
    const body = (await res.json()) as { success?: unknown } | null;
    return body !== null && typeof body === 'object' && 'success' in body ? 'service_not_found' : 'endpoint_not_found';
  } catch {
    // Content-type diz JSON mas o corpo não é: quem responde não é a API.
    return 'endpoint_not_found';
  }
}

/** Erro de rede do Node: a causa está no `code`/`name`, não na mensagem (que muda entre versões). */
function classifyNetworkError(err: unknown): ConnectivityReason {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  const name = (err as { name?: string })?.name;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failure';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  return 'network_error';
}

export async function checkConnectivity(input: ConnectivityInput, fetchImpl: FetchLike): Promise<ConnectivityResult> {
  const url = `${input.endpoint.replace(/\/$/, '')}/ingest/capture-policy?serviceId=${encodeURIComponent(input.serviceId)}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { 'x-api-key': input.apiKey } });
  } catch (err) {
    return { ok: false, reason: classifyNetworkError(err) };
  }

  if (res.ok) return { ok: true };

  switch (res.status) {
    case 400:
      return { ok: false, reason: 'bad_service_id', status: 400 };
    case 401:
      return { ok: false, reason: 'invalid_api_key', status: 401 };
    case 403:
      return { ok: false, reason: 'forbidden', status: 403 };
    case 404:
      return { ok: false, reason: await classifyNotFound(res), status: 404 };
    case 429:
      return { ok: false, reason: 'rate_limited', status: 429 };
    case 503:
      return { ok: false, reason: 'server_unavailable', status: 503 };
    default:
      return { ok: false, reason: 'unexpected_status', status: res.status };
  }
}
