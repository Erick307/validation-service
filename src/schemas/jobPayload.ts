import { z } from 'zod';

/**
 * Zod schema for the pg-boss job payload enqueued by image-intake-webhook.
 * Any job that fails this check is treated as malformed and will not be retried
 * (we throw a non-retryable error by logging and acking — see worker).
 */
export const JobPayloadSchema = z.object({
  request_id: z.string().uuid('request_id must be a valid UUID'),
  image_url: z.string().url('image_url must be a valid URL'),
  image_id: z.string().min(1, 'image_id is required'),
  metadata: z
    .record(z.unknown())
    .refine((val) => typeof val === 'object' && val !== null, {
      message: 'metadata must be an object',
    })
    .default({}),
});

export type JobPayloadInput = z.input<typeof JobPayloadSchema>;
export type JobPayloadOutput = z.output<typeof JobPayloadSchema>;
