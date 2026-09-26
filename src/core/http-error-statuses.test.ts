import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HTTP_CLIENT_ERROR_STATUSES,
  DEFAULT_HTTP_SERVER_ERROR_STATUSES,
  isValidHttpErrorStatuses,
  parseHttpErrorStatuses,
  resolveHttpErrorStatuses,
} from './http-error-statuses.js';

describe('parseHttpErrorStatuses (formato do Datadog)', () => {
  it('faixa e codigo avulso, com espacos', () => {
    const isError = parseHttpErrorStatuses(' 500-599 , 429 ');
    expect([429, 500, 503, 599].map(isError)).toEqual([true, true, true, true]);
    expect([200, 404, 430, 499].map(isError)).toEqual([false, false, false, false]);
  });

  it('faixa invertida vale igual', () => {
    expect(parseHttpErrorStatuses('599-500')(550)).toBe(true);
  });

  it('rejeita formato invalido', () => {
    expect(isValidHttpErrorStatuses('5xx')).toBe(false);
    expect(isValidHttpErrorStatuses('600')).toBe(false);
    expect(isValidHttpErrorStatuses('500-')).toBe(false);
    expect(() => parseHttpErrorStatuses('abc')).toThrow(/100 to 599/);
  });

  it('padroes: servidor 500-599; cliente 500-599 (divergencia consciente do Datadog)', () => {
    expect(DEFAULT_HTTP_SERVER_ERROR_STATUSES).toBe('500-599');
    expect(DEFAULT_HTTP_CLIENT_ERROR_STATUSES).toBe('500-599');
  });
});

describe('resolveHttpErrorStatuses', () => {
  it('a opcao vence a env', () => {
    const isError = resolveHttpErrorStatuses({
      option: '400-599',
      envValue: '500-599',
      envName: 'X',
      fallback: '500-599',
      warn: vi.fn(),
    });
    expect(isError(404)).toBe(true);
  });

  it('env valida vale quando nao ha opcao', () => {
    const isError = resolveHttpErrorStatuses({
      option: undefined,
      envValue: '500-599,429',
      envName: 'X',
      fallback: '500-599',
      warn: vi.fn(),
    });
    expect(isError(429)).toBe(true);
  });

  it('env invalida: aviso e padrao, como o Datadog', () => {
    const warn = vi.fn();
    const isError = resolveHttpErrorStatuses({
      option: undefined,
      envValue: '5xx',
      envName: 'X',
      fallback: '500-599',
      warn,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('X="5xx"'));
    expect(isError(503)).toBe(true);
    expect(isError(404)).toBe(false);
  });
});
