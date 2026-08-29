import { describe, expect, it } from 'vitest';
import { checkConfig } from './check-config.js';

const UUID = '33333333-3333-3333-3333-333333333333';

describe('checkConfig', () => {
  it('aprova configuracao completa', () => {
    const r = checkConfig({
      STACKTRACE_API_KEY: 'k-123',
      STACKTRACE_SERVICE_ID: UUID,
      STACKTRACE_ENDPOINT: 'https://ingest.example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('acusa variavel ausente, na ordem em que o dev preenche o .env', () => {
    const r = checkConfig({ STACKTRACE_API_KEY: 'k-123' });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.key)).toEqual(['STACKTRACE_SERVICE_ID', 'STACKTRACE_ENDPOINT']);
    expect(r.problems[0]?.reason).toBe('missing');
  });

  it('acusa serviceId que nao e uuid', () => {
    const r = checkConfig({
      STACKTRACE_API_KEY: 'k',
      STACKTRACE_SERVICE_ID: 'meu-servico',
      STACKTRACE_ENDPOINT: 'https://x.com',
    });
    expect(r.problems).toEqual([{ key: 'STACKTRACE_SERVICE_ID', reason: 'not_uuid' }]);
  });

  // `localhost:3000` parece endereco, mas o URL do Node le `localhost` como PROTOCOLO — o fetch
  // nunca sai da maquina e o sintoma e identico a "servidor fora do ar".
  it('acusa endpoint sem esquema', () => {
    const r = checkConfig({
      STACKTRACE_API_KEY: 'k',
      STACKTRACE_SERVICE_ID: UUID,
      STACKTRACE_ENDPOINT: 'localhost:3000',
    });
    expect(r.problems).toEqual([{ key: 'STACKTRACE_ENDPOINT', reason: 'not_url' }]);
  });

  it('aceita http alem de https (stack local)', () => {
    const r = checkConfig({
      STACKTRACE_API_KEY: 'k',
      STACKTRACE_SERVICE_ID: UUID,
      STACKTRACE_ENDPOINT: 'http://localhost:3000',
    });
    expect(r.ok).toBe(true);
  });

  // `export STACKTRACE_API_KEY=` e o modo mais comum de "configurei e nao funciona".
  it('trata string vazia como ausente, nao como valor', () => {
    const r = checkConfig({ STACKTRACE_API_KEY: '   ' });
    expect(r.problems.some((p) => p.key === 'STACKTRACE_API_KEY' && p.reason === 'missing')).toBe(true);
  });

  it('nao acusa formato de variavel ausente — so a ausencia', () => {
    const r = checkConfig({});
    expect(r.problems.map((p) => p.reason)).toEqual(['missing', 'missing', 'missing']);
  });

  it('acusa os tres problemas de formato de uma vez, sem parar no primeiro', () => {
    const r = checkConfig({
      STACKTRACE_API_KEY: 'k',
      STACKTRACE_SERVICE_ID: 'nao-uuid',
      STACKTRACE_ENDPOINT: 'nao-url',
    });
    expect(r.problems.map((p) => p.key)).toEqual(['STACKTRACE_SERVICE_ID', 'STACKTRACE_ENDPOINT']);
  });
});
