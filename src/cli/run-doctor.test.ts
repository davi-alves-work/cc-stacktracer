import { describe, expect, it, vi } from 'vitest';
import { runDoctor, type DoctorDeps } from './run-doctor.js';

const UUID = '33333333-3333-3333-3333-333333333333';

const GOOD_ENV = {
  STACKTRACE_API_KEY: 'k-123',
  STACKTRACE_SERVICE_ID: UUID,
  STACKTRACE_ENDPOINT: 'https://ingest.example.com',
};

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Roteia por URL: o doctor faz 4 chamadas diferentes e cada teste sobrescreve só a que importa. */
function fetchRouter(overrides: Record<string, ReturnType<typeof jsonRes>> = {}) {
  return vi.fn(async (url: string) => {
    for (const [fragment, res] of Object.entries(overrides)) {
      if (url.includes(fragment)) return res;
    }
    if (url.includes('/v1/instrumentation-audit')) {
      return jsonRes(200, {
        data: { score: 100, summary: { services: 1, fails: 0, warns: 0, score: 100 }, findings: [] },
      });
    }
    return jsonRes(200, { success: true });
  });
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cwd: '/app',
    env: GOOD_ENV,
    packageJson: { dependencies: { fastify: '^5.0.0' } },
    fetchImpl: fetchRouter() as never,
    ...over,
  };
}

describe('runDoctor', () => {
  it('caminho feliz: roda as quatro etapas e sai com 0', async () => {
    const report = await runDoctor(deps());

    expect(report.exitCode).toBe(0);
    expect(report.stack.http).toBe('fastify');
    expect(report.config.ok).toBe(true);
    expect(report.connectivity).toMatchObject({ ok: true });
    expect(report.probe).toMatchObject({ ok: true });
    expect(report.findings).toEqual([]);
  });

  // Uma causa por execucao: conectividade com serviceId invalido devolve 400, que o dev le como
  // "servidor com problema" quando a causa esta no .env dele.
  it('config invalida para tudo, sem tocar na rede', async () => {
    const fetchImpl = fetchRouter();
    const report = await runDoctor(deps({ env: { STACKTRACE_API_KEY: 'k' }, fetchImpl: fetchImpl as never }));

    expect(report.exitCode).toBe(1);
    expect(report.connectivity).toBeNull();
    expect(report.probe).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('conectividade quebrada nao tenta o envio sintetico', async () => {
    const fetchImpl = fetchRouter({ 'capture-policy': jsonRes(401, { success: false }) });
    const report = await runDoctor(deps({ fetchImpl: fetchImpl as never }));

    expect(report.exitCode).toBe(1);
    expect(report.connectivity).toMatchObject({ ok: false, reason: 'invalid_api_key' });
    expect(report.probe).toBeNull();
  });

  it('envio sintetico rejeitado reprova, e nao busca findings', async () => {
    const fetchImpl = fetchRouter({ '/v1/events': jsonRes(400, { code: 'VALIDATION_ERROR' }) });
    const report = await runDoctor(deps({ fetchImpl: fetchImpl as never }));

    expect(report.exitCode).toBe(1);
    expect(report.probe).toMatchObject({ ok: false });
    expect(report.findings).toBeNull();
  });

  // A instalacao FUNCIONA mesmo com gaps: um `fail` de instrumentacao virando CI vermelho faria o
  // cliente desligar o doctor inteiro.
  it('findings de severidade fail NAO reprovam o exit code', async () => {
    const fetchImpl = fetchRouter({
      '/v1/instrumentation-audit': jsonRes(200, {
        data: {
          score: 80,
          summary: { services: 1, fails: 1, warns: 0, score: 80 },
          findings: [{ serviceId: 's1', service: 'api', check: 'spans_missing', severity: 'fail', params: {} }],
        },
      }),
    });
    const report = await runDoctor(deps({ fetchImpl: fetchImpl as never }));

    expect(report.exitCode).toBe(0);
    expect(report.findings).toHaveLength(1);
  });

  it('audit indisponivel nao reprova — as etapas anteriores valem por si', async () => {
    const fetchImpl = fetchRouter({ '/v1/instrumentation-audit': jsonRes(503, { error: 'unavailable' }) });
    const report = await runDoctor(deps({ fetchImpl: fetchImpl as never }));

    expect(report.exitCode).toBe(0);
    expect(report.findings).toBeNull();
    expect(report.auditError).toBeTruthy();
  });

  it('sem package.json ainda checa config, rede e caminho de dados', async () => {
    const report = await runDoctor(deps({ packageJson: null }));

    expect(report.stack).toMatchObject({ http: null, empty: true });
    expect(report.exitCode).toBe(0);
    expect(report.probe).toMatchObject({ ok: true });
  });

  it('monorepo: package.json da raiz sem dependencias vira sinal, nao "stack nao reconhecida"', async () => {
    const report = await runDoctor(deps({ packageJson: { dependencies: {} } }));
    expect(report.stack.empty).toBe(true);
  });
});
