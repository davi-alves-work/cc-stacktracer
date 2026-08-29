import { describe, expect, it, vi } from 'vitest';
import { checkConnectivity } from './check-connectivity.js';

const base = {
  endpoint: 'https://ingest.example.com',
  apiKey: 'k-123',
  serviceId: '33333333-3333-3333-3333-333333333333',
};

/** Resposta com content-type, porque a classificação dos dois 404 depende dele. */
function res(status: number, opts: { contentType?: string; json?: unknown; jsonThrows?: boolean } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null) },
    json: async () => {
      if (opts.jsonThrows === true) throw new Error('not json');
      return opts.json;
    },
  };
}

const netErr = (props: Record<string, unknown>) => Object.assign(new Error('boom'), props);

describe('checkConnectivity', () => {
  it('ok quando responde 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    expect(await checkConnectivity(base, fetchImpl as never)).toEqual({ ok: true });
  });

  it('chama a rota de capture policy com a chave no header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    await checkConnectivity(base, fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${base.endpoint}/ingest/capture-policy?serviceId=${base.serviceId}`);
    expect(init.headers['x-api-key']).toBe('k-123');
  });

  it('nao duplica barra quando o endpoint termina em /', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    await checkConnectivity({ ...base, endpoint: 'https://ingest.example.com/' }, fetchImpl as never);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('.com//');
  });

  it('400 = serviceId ausente ou fora de formato', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(400));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'bad_service_id' });
  });

  it('401 = credencial invalida', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(401));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'invalid_api_key' });
  });

  it('403 = chave sem acesso ao servico', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(403));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'forbidden' });
  });

  // O par de 404 e a razao de ser desta funcao: as duas correcoes sao opostas.
  it('404 COM JSON da API = o serviceId nao pertence a esta chave', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(res(404, { contentType: 'application/json', json: { success: false } }));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'service_not_found' });
  });

  it('404 SEM JSON da API = o endpoint nao e uma ingestion-api', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, { contentType: 'text/html' }));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'endpoint_not_found' });
  });

  it('404 que diz JSON mas nao e = endpoint errado, nao servico inexistente', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, { contentType: 'application/json', jsonThrows: true }));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'endpoint_not_found' });
  });

  it('429 = rate limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(429));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'rate_limited' });
  });

  it('503 = infra do servidor, nao do cliente', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(503));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'server_unavailable' });
  });

  it('status fora da matriz nao vira falso diagnostico', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(418));
    expect(await checkConnectivity(base, fetchImpl as never)).toEqual({
      ok: false,
      reason: 'unexpected_status',
      status: 418,
    });
  });

  // Erros de rede: a causa esta no `code`/`name`, nunca na mensagem — ela muda entre versoes do Node.
  it.each([
    [netErr({ code: 'ENOTFOUND' }), 'dns_failure'],
    [netErr({ code: 'EAI_AGAIN' }), 'dns_failure'],
    [netErr({ code: 'ECONNREFUSED' }), 'connection_refused'],
    [netErr({ name: 'TimeoutError' }), 'timeout'],
    [netErr({ cause: { code: 'ECONNREFUSED' } }), 'connection_refused'],
  ])('classifica erro de rede %#', async (err, reason) => {
    const fetchImpl = vi.fn().mockRejectedValue(err);
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason });
  });

  it('erro de rede desconhecido nao vira diagnostico inventado', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('algo novo'));
    expect(await checkConnectivity(base, fetchImpl as never)).toMatchObject({ reason: 'network_error' });
  });
});
