import { dbPool } from '../../infrastructure/db'
import { objectStorageClient } from '../../infrastructure/objectStorage'
import { config } from '../../config/env'
import type { StimulusAssetJobPayload } from '../../app/schemas/job'
import { stimulusAssetJobPayloadSchema } from '../../app/schemas/job'

/**
 * MIMEタイプからstimulus_typeを判定します。
 * @param mimeType ファイルのMIMEタイプ
 * @returns 'image', 'audio', または 'other'
 */
const getStimulusTypeFromMime = (mimeType: string): 'image' | 'audio' | 'other' => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
};

/**
 * 1つの刺激アセット登録ジョブを処理します。
 * データベースのトランザクション内で実行され、原子性を保証します。
 * @param jobPayload パースおよびバリデーション済みのジョブペイロード
 */
async function processJob(jobPayload: StimulusAssetJobPayload): Promise<void> {
  const { experiment_id, csvDefinition, files } = jobPayload;
  const dbClient = await dbPool.connect();

  try {
    await dbClient.query('BEGIN');

    // CSV定義をファイル名で高速にルックアップできるようMapに変換
    const definitionMap = new Map(csvDefinition.map((def) => [def.file_name, def]));

    for (const file of files) {
      const fileBuffer = Buffer.from(file.contentBase64, 'base64');
      const objectId = `stimuli/${experiment_id}/${file.fileName}`;

      await objectStorageClient.putObject(
        config.OBJECT_STORAGE_MEDIA_BUCKET,
        objectId,
        fileBuffer,
        fileBuffer.length,
        { 'Content-Type': file.mimeType },
      );

      // 対応するCSV定義を取得
      const definition = definitionMap.get(file.fileName);
      if (!definition) {
        throw new Error(`Definition not found for file: ${file.fileName}`);
      }

      const stimulusType = getStimulusTypeFromMime(file.mimeType);

      // PostgreSQLにメタデータを登録 (UPSERT)
      await dbClient.query(
        `INSERT INTO experiment_stimuli (experiment_id, file_name, stimulus_type, trial_type, description, object_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (experiment_id, file_name) DO UPDATE SET
           stimulus_type = EXCLUDED.stimulus_type,
           trial_type = EXCLUDED.trial_type,
           description = EXCLUDED.description,
           object_id = EXCLUDED.object_id`,
        [
          experiment_id,
          definition.file_name,
          stimulusType,
          definition.trial_type,
          definition.description || null,
          objectId,
        ],
      );
      console.log(`  ✅ Processed and saved: ${file.fileName}`);
    }

    await dbClient.query('COMMIT');
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error(`❌ Transaction rolled back for experiment ${experiment_id}.`, error);
    // エラーを再スローして、呼び出し元 (queue consumer) に処理失敗を伝える
    throw error;
  } finally {
    dbClient.release();
  }
}

/**
 * RabbitMQから受信した生のメッセージをパース、バリデーションし、
 * ジョブ処理関数 (processJob) に渡します。
 * @param messageContent RabbitMQメッセージのコンテンツ (Buffer)
 */
export async function handleMessage(messageContent: Buffer): Promise<void> {
  try {
    const jobData = JSON.parse(messageContent.toString());
    const jobPayload = stimulusAssetJobPayloadSchema.parse(jobData);

    console.log(`[Job] Starting processing for experiment: ${jobPayload.experiment_id}`);
    await processJob(jobPayload);
    console.log(
      `[Job] Successfully completed processing for experiment: ${jobPayload.experiment_id}`,
    );
  } catch (error) {
    console.error('❌ Failed to handle message.', error);
    // エラーを再スローして、コンシューマにNACKをさせる
    throw error;
  }
}
