import { z } from 'zod';

/**
 * Structured error payload — separate from `message` for typed error analytics.
 */
export const ErrorSchema = z.object({
  type: z.string().min(1).max(512),
  message: z.string().min(1).max(16_000),
  stack: z.string().max(512_000).optional(),
});
