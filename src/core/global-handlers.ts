import { runDetached, safeRun, safeRunAsync } from './safe-run.js';

export type GlobalHandlersDeps = {
  captureException: (error: Error) => void;
  flush: () => Promise<void>;
  /** O que acontece quando o SDK precisa reproduzir o crash padrão do Node. Injetável para teste. */
  terminate?: (reason: unknown) => void;
};

const FLUSH_TIMEOUT_MS = 2_000;

type Registration = {
  onUncaught: (err: unknown) => void;
  onRejection: (reason: unknown) => void;
};

let registration: Registration | null = null;

function defaultTerminate(reason: unknown): void {
  console.error(reason);
  process.exit(1);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(`Non-Error thrown or rejected: ${String(value)}`);
}

/** Modo efetivo de `--unhandled-rejections`: a linha de comando vence `NODE_OPTIONS`; o default é `throw`. */
function unhandledRejectionsMode(): string {
  const flags = [...(process.env.NODE_OPTIONS ?? '').split(/\s+/), ...process.execArgv];
  let mode = 'throw';
  for (const flag of flags) {
    const match = /^--unhandled-rejections=(.+)$/.exec(flag);
    if (match?.[1] !== undefined) {
      mode = match[1];
    }
  }
  return mode;
}

function flushWithDeadline(flush: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    // Sem unref: neste caminho o processo precisa ficar vivo até terminarmos, ou sairia com código 0.
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    safeRunAsync('globalHandlers.flush', flush).then(done, done);
  });
}

/**
 * Handlers de último alarme (opt-in). A biblioteca observa; o destino do processo é da app:
 * - se o host tem listener próprio, o SDK captura e faz flush em background, e só;
 * - se o SDK é o único listener, registrar-se desligou o crash padrão do Node — então o SDK o reproduz
 *   depois do flush (imprime o erro, sai com 1), respeitando `--unhandled-rejections`.
 */
export function registerGlobalHandlers(deps: GlobalHandlersDeps): void {
  if (registration !== null) {
    return;
  }
  const terminate = deps.terminate ?? defaultTerminate;
  let terminating = false;

  const handle = (reason: unknown, mustCrash: boolean): void => {
    safeRun('globalHandlers.capture', () => deps.captureException(asError(reason)));
    if (!mustCrash) {
      runDetached('globalHandlers.flush', deps.flush);
      return;
    }
    if (terminating) {
      return;
    }
    terminating = true;
    flushWithDeadline(deps.flush).then(
      () => terminate(reason),
      () => terminate(reason),
    );
  };

  const onUncaught = (err: unknown): void => handle(err, process.listenerCount('uncaughtException') === 1);
  const onRejection = (reason: unknown): void =>
    handle(reason, process.listenerCount('unhandledRejection') === 1 && unhandledRejectionsMode() === 'throw');

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  registration = { onUncaught, onRejection };
}

export function unregisterGlobalHandlers(): void {
  if (registration === null) {
    return;
  }
  process.removeListener('uncaughtException', registration.onUncaught);
  process.removeListener('unhandledRejection', registration.onRejection);
  registration = null;
}
