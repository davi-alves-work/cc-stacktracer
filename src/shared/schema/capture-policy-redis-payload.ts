import { z } from 'zod';

/** Redis Pub/Sub channel for capture policy hot reload (ingestion subscribers). */
export const CAPTURE_POLICY_REDIS_CHANNEL = 'capture-policy:update' as const;

export const capturePolicyRedisUpdatePayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    serviceId: z.string().uuid().optional(),
    slug: z.string().min(1).max(512),
    policy: z.unknown(),
    updatedAt: z.number(),
  })
  .strict();

export type CapturePolicyRedisUpdatePayload = z.infer<typeof capturePolicyRedisUpdatePayloadSchema>;
