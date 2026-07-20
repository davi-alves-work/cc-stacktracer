/**
 * Best-effort SQL verb from a statement (`WITH …` is treated as `SELECT` for cardinality).
 */
export function extractSqlVerb(sql: string | undefined): string | undefined {
  if (sql === undefined || sql.trim() === '') return undefined;
  const m = sql.trim().match(/^\s*(WITH|SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i);
  if (m === null || m[1] === undefined) return undefined;
  const w = m[1].toUpperCase();
  if (w === 'WITH') return 'SELECT';
  return w;
}
