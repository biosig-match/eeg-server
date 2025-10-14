import { z } from 'zod';

/**
 * POST /api/v1/sessions/end の `metadata` パートのスキーマ
 */
const clockOffsetInfoBaseSchema = z
  .object({
    device_time_ms: z.number().int().nonnegative().optional(),
    server_time_ms: z.number().int().nonnegative().optional(),
    offset_ms: z.number().int(),
    measurement_timestamp: z
      .string()
      .datetime({ message: 'Invalid ISO 8601 datetime format for measurement_timestamp.' })
      .optional(),
  })
  .strict()
  .refine((obj) => JSON.stringify(obj).length <= 4096, {
    message: 'clock_offset_info must be less than 4KB.',
  });

export const clockOffsetInfoSchema = clockOffsetInfoBaseSchema.optional();

export const sessionEndMetadataSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  experiment_id: z.string().uuid().optional(),
  device_id: z.string().min(1),
  start_time: z.string().datetime({ message: 'Invalid ISO 8601 datetime format for start_time.' }),
  end_time: z.string().datetime({ message: 'Invalid ISO 8601 datetime format for end_time.' }),
  session_type: z.enum(['main_integrated', 'main_external', 'main_task', 'calibration']),
  clock_offset_info: clockOffsetInfoSchema,
});

/**
 * `events_log_csv` の各行のスキーマ
 */
export const eventLogCsvRowSchema = z.object({
  onset: z.coerce.number({ invalid_type_error: 'onset must be a number.' }).optional(),
  duration: z.coerce.number({ invalid_type_error: 'duration must be a number.' }).optional(),
  trial_type: z.string(),
  file_name: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional(),
});
