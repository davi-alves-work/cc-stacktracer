/**
 * Mesmo valor que `NULL_TRACE_ID`, e duplicado de propósito.
 *
 * Este arquivo é a única folha sem dependências do diretório; importar `canonical-event-v4.schema.js`
 * para buscar 32 caracteres arrastaria zod e o grafo inteiro de schemas para dentro de uma função que
 * só quebra uma string em `-`.
 *
 * E os dois nomes dizem coisas diferentes que coincidem por construção: aqui é "a W3C manda rejeitar
 * este valor" (§3.2.2.3); lá é "nós emitimos este valor para dizer que não há trace". Escolhemos o
 * inválido da spec como sentinela justamente porque ele é inválido — unir os dois apagaria essa
 * distinção. Cada um está fixado por teste, então divergência não passa em silêncio.
 */
const ALL_ZERO_TRACE_ID = '00000000000000000000000000000000';

/**
 * Parses W3C `traceparent` (`version-trace_id-parent_id-trace_flags`) for trace id extraction.
 * @see https://www.w3.org/TR/trace-context/
 */
export function parseTraceparentTraceId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return undefined;
  const [, traceId] = parts;
  if (traceId === undefined) return undefined;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return undefined;
  const lower = traceId.toLowerCase();
  if (lower === ALL_ZERO_TRACE_ID) return undefined;
  return lower;
}
