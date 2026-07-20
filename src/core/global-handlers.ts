export type GlobalHandlersDeps = {
  captureException: (error: Error) => void;
  flush: () => Promise<void>;
};

const FLUSH_TIMEOUT_MS = 2_000;

export function registerGlobalHandlers(deps: GlobalHandlersDeps): void {
  const prevUncaught = process.rawListeners('uncaughtException');
  const prevRejection = process.rawListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  process.on('uncaughtException', (err: Error) => {
    deps.captureException(err);

    // Await flush (with a hard deadline) before calling previous listeners so
    // the crash event is not lost when a previous handler calls process.exit(1).
    const flushWithTimeout = Promise.race([
      deps.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);

    void flushWithTimeout.finally(() => {
      for (const l of prevUncaught) {
        try {
          (l as (err: Error) => void)(err);
        } catch (inner) {
          console.error('[cc-stacktracer] error in previous uncaughtException listener', inner);
        }
      }
      // Safety net: if no previous listener exits the process we must do it
      // ourselves — keeping the process alive after uncaughtException is unsafe.
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    if (reason instanceof Error) {
      deps.captureException(reason);
      void deps.flush();
    }
    for (const l of prevRejection) {
      try {
        (l as (reason: unknown, p: Promise<unknown>) => void)(reason, promise);
      } catch (inner) {
        console.error('[cc-stacktracer] error in previous unhandledRejection listener', inner);
      }
    }
  });
}
