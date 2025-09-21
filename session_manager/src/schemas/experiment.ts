import { z } from 'zod';

/**
 * POST /api/v1/experiments
 * 新規実験作成時のリクエストボディのスキーマ
 */
export const createExperimentSchema = z.object({
  name: z.string().min(1, 'Experiment name is required.'),
  description: z.string().optional(),
  password: z.string().min(4, 'Password must be at least 4 characters.').optional(),
});

/**
 * `stimuli_definition_csv` の各行のスキーマ
 */
export const stimulusCsvRowSchema = z.object({
  trial_type: z.string().min(1, 'trial_type cannot be empty.'),
  file_name: z.string().min(1, 'file_name cannot be empty.'),
  description: z.string().optional(),
});
