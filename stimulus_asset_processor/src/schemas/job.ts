import { z } from 'zod';

/**
 * アップロードされる個々の刺激ファイルペイロードのスキーマ
 */
const stimulusFilePayloadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1),
});

/**
 * CSV定義ファイルの各行に対応するスキーマ
 */
const csvDefinitionRowSchema = z.object({
  trial_type: z.string(),
  file_name: z.string().min(1),
  description: z.string().optional(),
});

/**
 * RabbitMQから受信するジョブペイロード全体のスキーマ
 */
export const stimulusAssetJobPayloadSchema = z.object({
  experiment_id: z.string().uuid(),
  csvDefinition: z.array(csvDefinitionRowSchema),
  files: z.array(stimulusFilePayloadSchema),
});

// ジョブペイロードの型定義をエクスポート
export type StimulusAssetJobPayload = z.infer<typeof stimulusAssetJobPayloadSchema>;
