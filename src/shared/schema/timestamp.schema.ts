import { z } from 'zod';

/**
 * ISO 8601 timestamps (with or without offset). Used at validation boundaries for stable ClickHouse/event ordering.
 */
export const iso8601TimestampSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'Invalid ISO 8601 timestamp',
});
