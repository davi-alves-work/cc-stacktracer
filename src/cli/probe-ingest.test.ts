import { describe, expect, it, vi } from 'vitest';
import { EventSchemaV4 } from '../shared/schema/index.js';
import { DOCTOR_SOURCE_TAG, probeIngest } from './probe-ingest.js';

const base = {
  endpoint: 'https://ingest.example.com',
  apiKey: 'k-123',
  serviceId: '33333333-3333-4333-a333-333333333333',
};

const okRes = { ok: true, status: 202, text: async () => '' };
const errRes = (status: number, body = '') => ({ ok: false, status, text: async () => body });

type Call = [string, { method: string; headers: Record<string, string>; body: string }];

describe('probeIngest', () => {
  it('exercita os DOIS endpoints do contrato v4', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    const out = await probeIngest(base, fetchImpl as never);

    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => s.step)).toEqual(['events', 'spans']);
    const urls = (fetchImpl.mock.calls as Call[]).map(([u]) => u);
    expect(urls).toEqual(['https://ingest.example.com/v1/events', 'https://ingest.example.com/v1/spans']);
  });

  // A decisao de 2026-08-29: log + span, nunca erro. Um erro sintetico deixaria um grupo permanente
  // no /errors do cliente, e ninguem depois sabe se aquele grupo e real.
  it('NAO envia erro — so log e span', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest(base, fetchImpl as never);

    const bodies = (fetchImpl.mock.calls as Call[]).map(([, init]) => init.body);
    expect(bodies[0]).toContain('"type":"log"');
    expect(bodies.join(' ')).not.toContain('"type":"error"');
  });

  it('marca os dois envios como vindos do doctor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest(base, fetchImpl as never);

    const [events, spans] = (fetchImpl.mock.calls as Call[]).map(([, init]) => init.body);
    expect(events).toContain(DOCTOR_SOURCE_TAG);
    expect(spans).toContain(DOCTOR_SOURCE_TAG);
  });

  it('correlaciona log e span pelo mesmo trace_id W3C', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    const out = await probeIngest(base, fetchImpl as never);

    expect(out.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const [, init] of fetchImpl.mock.calls as Call[]) {
      expect(init.body).toContain(out.traceId);
    }
  });

  it('assina cada POST com os tres cabecalhos de HMAC', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest(base, fetchImpl as never);

    for (const [, init] of fetchImpl.mock.calls as Call[]) {
      expect(init.headers['x-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(init.headers['x-timestamp']).toBeTruthy();
      expect(init.headers['x-nonce']).toBeTruthy();
      expect(init.headers['x-api-key']).toBe('k-123');
    }
  });

  // Assinaturas iguais para corpos diferentes significaria canonica montada errado.
  it('assina cada corpo separadamente — nonce e assinatura nao se repetem', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest(base, fetchImpl as never);

    const [a, b] = (fetchImpl.mock.calls as Call[]).map(([, init]) => init.headers);
    expect(a?.['x-signature']).not.toBe(b?.['x-signature']);
    expect(a?.['x-nonce']).not.toBe(b?.['x-nonce']);
  });

  // Se o primeiro falha por credencial, o segundo falharia pelo mesmo motivo — dois erros para um
  // problema so e ruido que atrapalha quem esta instalando.
  it('para no primeiro passo que falha, sem enviar o segundo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(401, '{"code":"UNAUTHORIZED"}'));
    const out = await probeIngest(base, fetchImpl as never);

    expect(out.ok).toBe(false);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ step: 'events', ok: false, status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('devolve o corpo de erro da API, truncado', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(400, 'x'.repeat(500)));
    const out = await probeIngest(base, fetchImpl as never);
    expect(out.steps[0]?.detail?.length).toBe(300);
  });

  it('span que falha depois de events ok reporta os dois passos', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okRes).mockResolvedValueOnce(errRes(503));
    const out = await probeIngest(base, fetchImpl as never);

    expect(out.ok).toBe(false);
    expect(out.steps.map((s) => s.ok)).toEqual([true, false]);
  });

  it('erro de rede nao derruba o CLI', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await probeIngest(base, fetchImpl as never);
    expect(out).toMatchObject({ ok: false });
    expect(out.steps[0]?.detail).toContain('ECONNREFUSED');
  });

  it('nao duplica barra quando o endpoint termina em /', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest({ ...base, endpoint: 'https://ingest.example.com/' }, fetchImpl as never);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://ingest.example.com/v1/events');
  });
});

/**
 * O teste que faltava, e que teria pego o defeito antes de a 2.4.0 sair.
 *
 * Os testes acima conferiam a MECANICA (dois endpoints, assinatura, dedupe) e nenhum conferia se o
 * corpo casa com o contrato. Os dois schemas sao `.strict()`: campo faltando E campo sobrando dao
 * 400, entao o passo que existe para provar a ingestao falharia para todo usuario, sempre.
 */
describe('payload sintetico contra o schema v4 real', () => {
  const call = async (): Promise<{ events: unknown; spans: unknown }> => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes);
    await probeIngest(base, fetchImpl as never);
    const [ev, sp] = (fetchImpl.mock.calls as Call[]).map(
      ([, init]) => JSON.parse(init.body) as Record<string, unknown>,
    );
    return { events: (ev?.events as unknown[])[0], spans: (sp?.spans as unknown[])[0] };
  };

  it('o log passa em EventSchemaV4', async () => {
    const { events } = await call();
    const r = EventSchemaV4.safeParse(events);
    expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  });

  // O span nao tem schema zod vendorizado no SDK — quem cobre e o tipo `SdkSpanRow`, em
  // compilacao. Aqui conferimos o que o tipo nao alcanca: os nomes que o servidor EXIGE e os que
  // ele REJEITA (o schema e `.strict()` dos dois lados).
  it('o span usa o vocabulario que o servidor exige, e nenhum que ele rejeita', async () => {
    const { spans } = await call();
    const s = spans as Record<string, unknown>;
    for (const req of ['span_timestamp', 'start_time', 'end_time', 'span_name', 'duration_us', 'service_id']) {
      expect(s, `falta ${req}`).toHaveProperty(req);
    }
    for (const proibido of ['schema_version', 'timestamp', 'name']) {
      expect(s, `${proibido} e rejeitado pelo schema estrito`).not.toHaveProperty(proibido);
    }
  });

  it('duration_us bate com o intervalo start_time..end_time', async () => {
    const { spans } = await call();
    const s = spans as { start_time: string; end_time: string; duration_us: number };
    expect(Date.parse(s.end_time) - Date.parse(s.start_time)).toBe(s.duration_us / 1000);
  });
});
