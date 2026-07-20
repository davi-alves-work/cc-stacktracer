import { z } from 'zod';

/** Low-cardinality string tags for faceted search and dashboards. */
export const TagsSchema = z.record(z.string().min(1).max(128), z.string().min(1).max(1024));
