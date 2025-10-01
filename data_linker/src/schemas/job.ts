import { z } from 'zod';

/**
 * Zod schema for the job payload received from the DATA_LINKER_QUEUE.
 * This must match the payload structure sent by the Session Manager service.
 */
export const dataLinkerJobPayloadSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  experiment_id: z.string().uuid(),
  session_start_utc: z.string().datetime(),
  session_end_utc: z.string().datetime(),
  clock_offset_info: z
    .object({
      offset_ms_avg: z.number(),
      rtt_ms_avg: z.number(),
    })
    .optional(), // Optional to handle cases where time sync might have failed
});

export type DataLinkerJobPayload = z.infer<typeof dataLinkerJobPayloadSchema>;
