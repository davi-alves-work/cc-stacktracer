import { z } from 'zod';

const MAX_STATEMENT = 500;

/**
 * Database operation — enables slow-query grouping and system breakdowns.
 */
export const DbSchema = z.object({
  system: z.union([z.enum(['sqlserver', 'postgres', 'mysql']), z.string().min(1).max(128)]),
  operation: z.union([z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE']), z.string().min(1).max(64)]),
  table: z.string().min(1).max(256),
  duration_ms: z.number().nonnegative(),
  /** Truncated SQL for debugging; never full production secrets in high-volume paths. */
  statement: z
    .preprocess((val) => (typeof val === 'string' ? val.slice(0, MAX_STATEMENT) : val), z.string().max(MAX_STATEMENT))
    .optional(),
  rows: z.number().int().nonnegative().optional(),
});
