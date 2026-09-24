import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FUSE_THRESHOLD,
  isTelemetryActive,
  reportInternalFailure,
  resetFailOpenState,
  runDetached,
  safeRun,
  safeRunAsync,
  setInternalFailureSink,
} from './safe-run.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFailOpenState();
});

describe('safeRun', () => {
  it('devolve o valor quando o código de telemetria funciona', () => {
    expect(safeRun('t', () => 42)).toBe(42);
  });

  it('engole o throw, devolve undefined e reporta com o label', () => {
    const sink = vi.fn();
    setInternalFailureSink(sink);
    const err = new Error('boom');
    expect(
      safeRun('span.end', () => {
        throw err;
      }),
    ).toBeUndefined();
    expect(sink).toHaveBeenCalledWith('span.end', err);
  });

  it('é silencioso por padrão: sem sink, nada no console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeRun('x', () => {
      throw new Error('boom');
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('safeRunAsync / runDetached', () => {
  it('safeRunAsync resolve undefined numa rejeição e reporta', async () => {
    const sink = vi.fn();
    setInternalFailureSink(sink);
    await expect(
      safeRunAsync('flush', async () => {
        throw new Error('down');
      }),
    ).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledWith('flush', expect.objectContaining({ message: 'down' }));
  });

  it('runDetached é dono da rejeição de uma promise que ninguém aguarda', async () => {
    const sink = vi.fn();
    setInternalFailureSink(sink);
    runDetached('queue.flush', () => Promise.reject(new Error('lost')));
    await vi.waitFor(() =>
      expect(sink).toHaveBeenCalledWith('queue.flush', expect.objectContaining({ message: 'lost' })),
    );
  });

  it('runDetached também é dono de um throw síncrono de quem cria a promise', async () => {
    const sink = vi.fn();
    setInternalFailureSink(sink);
    runDetached('starter', () => {
      throw new Error('sync');
    });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledWith('starter', expect.objectContaining({ message: 'sync' })));
  });
});

describe('reportInternalFailure', () => {
  it('limita o sink a um relato por label por janela', () => {
    const sink = vi.fn();
    setInternalFailureSink(sink);
    reportInternalFailure('a', new Error('1'));
    reportInternalFailure('a', new Error('2'));
    reportInternalFailure('b', new Error('3'));
    expect(sink.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
  });

  it('nunca lança quando o sink (logger do cliente) lança', () => {
    setInternalFailureSink(() => {
      throw new Error('logger down');
    });
    expect(() => reportInternalFailure('x', new Error('boom'))).not.toThrow();
  });

  it('não reentra no sink quando o próprio sink provoca um relato', () => {
    const labels: string[] = [];
    setInternalFailureSink((label) => {
      labels.push(label);
      reportInternalFailure('from-sink', new Error('loop'));
    });
    reportInternalFailure('outer', new Error('boom'));
    expect(labels).toEqual(['outer']);
  });

  it(`desarma o fusível após ${FUSE_THRESHOLD} falhas: telemetria inativa e um único aviso`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isTelemetryActive()).toBe(true);
    for (let i = 0; i < FUSE_THRESHOLD; i += 1) reportInternalFailure('hot.path', new Error(String(i)));
    expect(isTelemetryActive()).toBe(false);
    for (let i = 0; i < 10; i += 1) reportInternalFailure('hot.path', new Error('more'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resetFailOpenState rearma o fusível', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < FUSE_THRESHOLD; i += 1) reportInternalFailure('x', new Error('e'));
    resetFailOpenState();
    expect(isTelemetryActive()).toBe(true);
  });

  it('fica inativo com o kill switch ligado', () => {
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    expect(isTelemetryActive()).toBe(false);
  });
});
