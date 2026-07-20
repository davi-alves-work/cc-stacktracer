import { z } from 'zod';

/**
 * Deployed service identity — low-cardinality dimensions for grouping and SLO rollups.
 */
export const ServiceSchema = z.object({
  /** Logical service name (e.g. `checkout-api`). */
  name: z.string().min(1).max(256),
  /** Release / build id; `unknown` when not provided by SDK. */
  version: z.string().max(256),
  /** Deployment slice (e.g. `production`, `staging`). */
  environment: z.string().min(1).max(256),
});
