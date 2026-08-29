import { describe, expect, it, vi } from 'vitest';
import { createRuntimeNoticeReporter } from './runtime-notices.js';
import type { CapturePolicyNotice } from '../../shared/schema/index.js';

const notice = (
  code: CapturePolicyNotice['code'],
  params: Record<string, string | number> = {},
): CapturePolicyNotice => ({
  code,
  severity: 'warn',
  params,
});

describe('createRuntimeNoticeReporter', () => {
  it('renderiza o aviso em ingles, com prefixo greppavel', () => {
    const log = vi.fn();
    createRuntimeNoticeReporter({ log })([notice('service_version_missing')]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('[cc-stacktracer]');
    expect(log.mock.calls[0]?.[0]).toContain('service_version');
  });

  it('interpola os params que o servidor mandou', () => {
    const log = vi.fn();
    createRuntimeNoticeReporter({ log })([notice('silent', { minutes: 47 })]);
    expect(log.mock.calls[0]?.[0]).toContain('47');
  });

  // O polling repete a cada ciclo (minimo 60s). Sem dedupe, a mesma linha sairia a cada minuto ate
  // alguem desligar o SDK — e o dev aprenderia a ignorar o canal que existe para ele prestar atencao.
  it('loga cada code UMA vez por processo, mesmo com o poll repetindo', () => {
    const log = vi.fn();
    const report = createRuntimeNoticeReporter({ log });

    report([notice('service_version_missing')]);
    report([notice('service_version_missing')]);
    report([notice('service_version_missing')]);

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('code novo num ciclo posterior ainda e logado', () => {
    const log = vi.fn();
    const report = createRuntimeNoticeReporter({ log });

    report([notice('service_version_missing')]);
    report([notice('service_version_missing'), notice('environment_missing')]);

    expect(log).toHaveBeenCalledTimes(2);
  });

  it('suppress silencia tudo — log nao solicitado em producao irrita', () => {
    const log = vi.fn();
    createRuntimeNoticeReporter({ log, suppress: true })([notice('no_data')]);
    expect(log).not.toHaveBeenCalled();
  });

  it('lista vazia nao imprime nada', () => {
    const log = vi.fn();
    createRuntimeNoticeReporter({ log })([]);
    expect(log).not.toHaveBeenCalled();
  });
});
