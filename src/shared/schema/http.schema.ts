import { z } from 'zod';
import { routeHasRawDynamicSegments } from './route-validation.js';

/**
 * HTTP request/response slice — snake_case for OLAP/ClickHouse alignment.
 * `route` must be a normalized pattern (placeholders), not concrete ids.
 */
export const HttpSchema = z
  .object({
    method: z.string().min(1).max(32),
    /** Framework route template for grouping (e.g. `/users/:id`). */
    route: z.string().min(1).max(2048),
    url: z.string().max(8192).optional(),
    status_code: z.number().int(),
    duration_ms: z.number().nonnegative(),
    scheme: z.string().min(1).max(32).optional(),
    client: z
      .object({
        address: z.string().min(1).max(2048).optional(),
      })
      .optional(),
    'user_agent.original': z.string().min(1).max(2048).optional(),
  })
  .superRefine((data, ctx) => {
    if (routeHasRawDynamicSegments(data.route)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'route must not contain raw numeric or UUID segments; use patterns (e.g. /users/:id) or put the raw URL in `url`',
        path: ['route'],
      });
    }
  });
