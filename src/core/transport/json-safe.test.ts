import { describe, expect, it } from 'vitest';
import { toJsonSafe } from './json-safe.js';

describe('toJsonSafe', () => {
  it('transforma BigInt na string decimal', () => {
    expect(toJsonSafe({ id: 10n, nested: [1n] })).toEqual({ id: '10', nested: ['1'] });
  });

  it('troca ciclo por marcador e continua serializável', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const safe = toJsonSafe(a);
    expect(safe).toEqual({ name: 'a', self: '[Circular]' });
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it('mantém nos dois lugares uma referência compartilhada que não é ciclo', () => {
    const shared = { v: 1 };
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('respeita toJSON (Date) e descarta função e symbol como o JSON.stringify', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    expect(toJsonSafe({ when, fn: () => 1, sym: Symbol('s'), list: [() => 1] })).toEqual({
      when: '2026-01-01T00:00:00.000Z',
      list: [null],
    });
  });

  it('limita a profundidade', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(toJsonSafe(deep))).toContain('[Truncated]');
  });

  it('limita o número de objetos visitados', () => {
    const wide = Array.from({ length: 5_000 }, (_, i) => ({ i }));
    const safe = toJsonSafe(wide) as unknown[];
    expect(safe.filter((item) => item === '[Truncated]').length).toBeGreaterThan(0);
  });

  it('deixa primitivos passarem', () => {
    expect(toJsonSafe('x')).toBe('x');
    expect(toJsonSafe(3)).toBe(3);
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeUndefined();
  });
});
