import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { dbPool } from '../lib/db';
import { minioClient } from '../lib/minio';
import { requireUser } from '../middleware/auth';
import { config } from '../lib/config';
import { resolveStimulusMime } from '../utils/mime';

export const stimuliRouter = new Hono();

// :filename パラメータで動的にファイル名を受け取る
stimuliRouter.get('/download/:filename', requireUser(), async (c) => {
  const { filename } = c.req.param();

  if (!filename) {
    return c.json({ error: 'Filename is required' }, 400);
  }

  try {
    const stimuliResult = await dbPool.query(
      `SELECT object_id,
              COALESCE(s.stimulus_type, 'image') as type
       FROM experiment_stimuli s WHERE file_name = $1
       UNION
       SELECT object_id,
              'image' as type
       FROM calibration_items c WHERE file_name = $1`,
      [filename],
    );

    if (stimuliResult.rowCount === 0) {
      return c.json({ error: 'Stimulus not found' }, 404);
    }

    const { object_id, type } = stimuliResult.rows[0];

    const objectStream = await minioClient.getObject(config.MINIO_MEDIA_BUCKET, object_id);

    c.header('Content-Type', resolveStimulusMime(filename, type));
    c.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

    // ### <<< 修正点 >>> ###
    // Honoの stream.pipe() はストリームの型が合わないため使用しない。
    // 代わりに、Node.jsのストリームを for await...of でチャンクごとに読み取り、
    // Honoのストリームに手動で書き込む方式に変更する。
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
