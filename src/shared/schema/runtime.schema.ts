import { z } from 'zod';

/**
 * Process/runtime context — useful for attributing errors across Node versions and OS.
 */
export const RuntimeSchema = z.object({
  node_version: z.string().max(64).optional(),
  platform: z.string().max(64).optional(),
  /** e.g. `arm64`, `x64` */
  arch: z.string().max(32).optional(),
});
