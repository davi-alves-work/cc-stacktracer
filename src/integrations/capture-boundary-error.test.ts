import { describe, expect, it, vi } from 'vitest';
import { captureBoundaryError } from './capture-boundary-error.js';

describe('captureBoundaryError', () => {
  it('não captura quando a opção está desligada', () => {
    const capture = vi.fn();
    captureBoundaryError(new Error('x'), { captureErrors: false }, capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it('não captura quando a opção está ausente — o default é desligado', () => {
    const capture = vi.fn();
    captureBoundaryError(new Error('x'), {}, capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it('captura uma vez quando ligada', () => {
    const capture = vi.fn();
    const err = new Error('boom');
    captureBoundaryError(err, { captureErrors: true }, capture);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(err, { captured_by: 'http-boundary' });
  });

  it('não captura o mesmo erro duas vezes', () => {
    const capture = vi.fn();
    const err = new Error('boom');
    captureBoundaryError(err, { captureErrors: true }, capture);
    captureBoundaryError(err, { captureErrors: true }, capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('converte um throw não-Error em Error', () => {
    const capture = vi.fn();
    captureBoundaryError('string solta', { captureErrors: true }, capture);
    expect(capture.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((capture.mock.calls[0]?.[0] as Error).message).toBe('string solta');
  });

  it('não lança nem corrompe o erro quando ele está congelado', () => {
    const capture = vi.fn();
    const err = Object.freeze(new Error('congelado'));
    expect(() => captureBoundaryError(err, { captureErrors: true }, capture)).not.toThrow();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toBe(err);
  });

  it('deduplica erro congelado sem mutá-lo', () => {
    const capture = vi.fn();
    const err = Object.freeze(new Error('congelado'));
    captureBoundaryError(err, { captureErrors: true }, capture);
    captureBoundaryError(err, { captureErrors: true }, capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
