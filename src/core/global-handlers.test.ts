import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGlobalHandlers } from './global-handlers.js';

describe('registerGlobalHandlers', () => {
  const captureException = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers uncaughtException and unhandledRejection listeners when called', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerGlobalHandlers({ captureException, flush });

    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    onSpy.mockRestore();
  });
});
