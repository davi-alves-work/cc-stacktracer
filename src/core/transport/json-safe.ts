const MAX_DEPTH = 8;
const MAX_NODES = 1_000;

/**
 * Cópia serializável de um valor vindo do cliente. `JSON.stringify` lança com BigInt e com ciclo — e
 * um lote que lança no envio fica na frente da fila. Aqui BigInt vira string, ciclo vira marcador, e
 * profundidade e quantidade de objetos têm teto para o custo no hot path ser limitado.
 */
export function toJsonSafe(value: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();

  const walk = (current: unknown, depth: number): unknown => {
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'function' || typeof current === 'symbol') return undefined;
    if (current === null || typeof current !== 'object') return current;
    if (ancestors.has(current)) return '[Circular]';
    if (depth >= MAX_DEPTH || nodes >= MAX_NODES) return '[Truncated]';
    nodes += 1;
    ancestors.add(current);
    try {
      const toJSON = (current as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        return walk(toJSON.call(current), depth + 1);
      }
      if (Array.isArray(current)) {
        return current.map((item) => walk(item, depth + 1) ?? null);
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        const safe = walk(item, depth + 1);
        if (safe !== undefined) out[key] = safe;
      }
      return out;
    } finally {
      ancestors.delete(current);
    }
  };

  return walk(value, 0);
}
