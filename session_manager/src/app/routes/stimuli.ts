import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { dbPool } from '../../infrastructure/db';
import { minioClient } from '../../infrastructure/minio';
import { requireAuth, requireUser } from '../middleware/auth';
import { config } from '../../config/env';
import { resolveStimulusMime } from '../../shared/utils/mime';

export const stimuliRouter = new Hono();

// キャリブレーション用刺激をダウンロード
stimuliRouter.get('/calibration/download/:filename', requireUser(), async (c) => {
  const { filename } = c.req.param();

  if (!filename) {
    return c.json({ error: 'Filename is required' }, 400);
  }

  try {
    const calibrationResult = await dbPool.query(
      `SELECT object_id,
              'image' AS type
       FROM calibration_items
       WHERE file_name = $1`,
      [filename],
    );

    if (calibrationResult.rowCount === 0) {
      return c.json({ error: 'Calibration stimulus not found' }, 404);
    }

    const { object_id, type } = calibrationResult.rows[0];
    const objectStream = await minioClient.getObject(config.MINIO_MEDIA_BUCKET, object_id);

    c.header('Content-Type', resolveStimulusMime(filename, type));
    c.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

    return stream(c, async (streamWriter) => {
      for await (const chunk of objectStream) {
        await streamWriter.write(chunk);
      }
    });
  } catch (error) {
    console.error(`Failed to download calibration stimulus ${filename}:`, error);
    return c.json({ error: 'Failed to retrieve calibration stimulus' }, 500);
  }
});

// 実験IDとファイル名を指定して刺激をダウンロード
stimuliRouter.get('/:experiment_id/download/:filename', requireAuth('participant'), async (c) => {
  const { experiment_id, filename } = c.req.param();

  if (!experiment_id || !filename) {
    return c.json({ error: 'experiment_id and filename are required' }, 400);
  }

  try {
    const stimuliResult = await dbPool.query(
      `SELECT object_id,
              COALESCE(s.stimulus_type, 'image') AS type
       FROM experiment_stimuli s
       WHERE s.experiment_id = $1 AND s.file_name = $2
       UNION ALL
       SELECT object_id,
              'image' AS type
       FROM calibration_items c
       WHERE c.file_name = $2`,
      [experiment_id, filename],
    );

    if (stimuliResult.rowCount === 0) {
      return c.json({ error: 'Stimulus not found' }, 404);
    }

    const { object_id, type } = stimuliResult.rows[0];

    const objectStream = await minioClient.getObject(config.MINIO_MEDIA_BUCKET, object_id);

    c.header('Content-Type', resolveStimulusMime(filename, type));
    c.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

    /**
     * Hono の stream.pipe() は Node.js の Readable とは互換性がないため、
     * for await...of でチャンクを読み取り Hono のストリームへ手動で書き込む。
     */
    return stream(c, async (stream) => {
      for await (const chunk of objectStream) {
        await stream.write(chunk);
      }
    });
  } catch (error) {
    console.error(`Failed to download stimulus ${filename}:`, error);
    return c.json({ error: 'Failed to retrieve stimulus file' }, 500);
  }
});
