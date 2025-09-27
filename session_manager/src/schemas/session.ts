import { z } from 'zod';

/**
 * POST /api/v1/sessions/end の `metadata` パートのスキーマ
 */
export const sessionEndMetadataSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  experiment_id: z.string().uuid(),
  device_id: z.string().min(1),
  start_time: z.string().datetime({ message: 'Invalid ISO 8601 datetime format for start_time.' }),
  end_time: z.string().datetime({ message: 'Invalid ISO 8601 datetime format for end_time.' }),
  session_type: z.enum(['main_integrated', 'main_external', 'calibration']),
  clock_offset_info: z
    .object({
      offset_ms_avg: z.number(),
      rtt_ms_avg: z.number(),
    })
    .optional(),
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
