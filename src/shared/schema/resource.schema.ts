import { z } from 'zod';

/**
 * Generic resource attribution (OpenTelemetry-style name/type) — avoid raw PII in values.
 */
export const ResourceSchema = z.object({
  name: z.string().min(1).max(512),
  type: z.string().min(1).max(128),
});
