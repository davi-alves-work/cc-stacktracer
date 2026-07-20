import { z } from 'zod';

/**
 * Business-domain observability — entity lifecycle and actor for product analytics.
 */
export const BusinessSchema = z.object({
  entity: z.string().min(1).max(256),
  operation: z.string().min(1).max(256),
  fields_changed: z.array(z.string().max(128)).max(64).optional(),
  user_id: z.string().max(256).optional(),
});
