import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalHandlers, unregisterGlobalHandlers } from './global-handlers.js';
import { resetFailOpenState } from './safe-run.js';

type ProcessEvent = 'uncaughtException' | 'unhandledRejection';
type Listener = (...args: unknown[]) => void;

const EVENTS: ProcessEvent[] = ['uncaughtException', 'unhandledRejection'];

describe('registerGlobalHandlers', () => {
  const saved: Record<ProcessEvent, Listener[]> = { uncaughtException: [], unhandledRejection: [] };
  let savedExecArgv: string[];

  beforeEach(() => {
    // Isola o teste dos listeners do próprio Vitest: a regra "o SDK é o único listener?" depende da contagem.
    for (const event of EVENTS) {
      saved[event] = process.rawListeners(event) as Listener[];
      process.removeAllListeners(event);
    }
    savedExecArgv = process.execArgv;
    process.execArgv = [];
    vi.stubEnv('NODE_OPTIONS', '');
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    unregisterGlobalHandlers();
    for (const event of EVENTS) {
      process.removeAllListeners(event);
      for (const listener of saved[event]) process.on(event, listener);
    }
    process.execArgv = savedExecArgv;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetFailOpenState();
  });

  function sdkListener(event: ProcessEvent): Listener {
    const last = (process.listeners(event) as Listener[]).at(-1);
    if (last === undefined) throw new Error(`nenhum listener de ${event}`);
    return last;
  }

  function deps() {
    return {
      captureException: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
  }

  it('mantém os listeners que o host registrou antes', () => {
    const host = vi.fn();
    process.on('uncaughtException', host);
    registerGlobalHandlers(deps());
    expect(process.listeners('uncaughtException')).toContain(host);
    expect(process.listenerCount('uncaughtException')).toBe(2);
  });

  it('registra uma vez só, quantas vezes o init rodar', () => {
    registerGlobalHandlers(deps());
    registerGlobalHandlers(deps());
    expect(process.listenerCount('uncaughtException')).toBe(1);
    expect(process.listenerCount('unhandledRejection')).toBe(1);
  });

  it('único listener de uncaughtException: captura, faz flush e reproduz o crash padrão', async () => {
    const d = deps();
    registerGlobalHandlers(d);
    const err = new Error('boom');
    sdkListener('uncaughtException')(err);
    await vi.waitFor(() => expect(d.terminate).toHaveBeenCalledWith(err));
    expect(d.captureException).toHaveBeenCalledWith(err);
    expect(d.flush.mock.invocationCallOrder[0]!).toBeLessThan(d.terminate.mock.invocationCallOrder[0]!);
  });

  it('com listener próprio do host, o destino do processo fica com o host', async () => {
    process.on('uncaughtException', () => {});
    const d = deps();
    registerGlobalHandlers(d);
    sdkListener('uncaughtException')(new Error('boom'));
    await vi.waitFor(() => expect(d.flush).toHaveBeenCalled());
    expect(d.terminate).not.toHaveBeenCalled();
  });

  it('único listener de unhandledRejection: mantém o crash padrão e captura motivo que não é Error', async () => {
    const d = deps();
    registerGlobalHandlers(d);
    sdkListener('unhandledRejection')('motivo em string', Promise.resolve());
    await vi.waitFor(() => expect(d.terminate).toHaveBeenCalledWith('motivo em string'));
    expect(d.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('motivo em string') }),
    );
  });

  it('com --unhandled-rejections=warn não derruba o processo', async () => {
    process.execArgv = ['--unhandled-rejections=warn'];
    const d = deps();
    registerGlobalHandlers(d);
    sdkListener('unhandledRejection')(new Error('x'), Promise.resolve());
    await vi.waitFor(() => expect(d.flush).toHaveBeenCalled());
    expect(d.terminate).not.toHaveBeenCalled();
  });

  it('captureException que lança nunca interrompe o caminho do crash', async () => {
    const d = deps();
    d.captureException.mockImplementation(() => {
      throw new Error('capture bug');
    });
    registerGlobalHandlers(d);
    const err = new Error('boom');
    expect(() => sdkListener('uncaughtException')(err)).not.toThrow();
    await vi.waitFor(() => expect(d.terminate).toHaveBeenCalledWith(err));
  });

  it('termina no prazo do flush quando o envio pendura', async () => {
    vi.useFakeTimers();
    const d = deps();
    d.flush.mockReturnValue(new Promise<void>(() => {}));
    registerGlobalHandlers(d);
    sdkListener('uncaughtException')(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(d.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.terminate).toHaveBeenCalledTimes(1);
  });
});
