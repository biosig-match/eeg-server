import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { parse as csvParse } from 'csv-parse/sync';
import { dbPool } from '../lib/db';
import { getAmqpChannel } from '../lib/queue';
import { createExperimentSchema, stimulusCsvRowSchema } from '../schemas/experiment';
import { config } from '../lib/config';
import { requireAuth } from '../middleware/auth';

export const experimentsRouter = new Hono();

// POST /api/v1/experiments - 新規実験の作成
experimentsRouter.post('/', zValidator('json', createExperimentSchema), async (c) => {
  const { name, description, password, presentation_order } = c.req.valid('json');
  const creatorId = c.req.header('X-User-Id');
  if (!creatorId) {
    return c.json({ error: 'X-User-Id header is required to create an experiment.' }, 400);
  }

  const dbClient = await dbPool.connect();
  try {
    await dbClient.query('BEGIN');

    const passwordHash = password ? await Bun.password.hash(password) : null;

    const experimentResult = await dbClient.query(
      'INSERT INTO experiments (name, description, password_hash, presentation_order) VALUES ($1, $2, $3, $4) RETURNING experiment_id',
      [name, description || null, passwordHash, presentation_order],
    );
    const newExperimentId = experimentResult.rows[0].experiment_id;

    await dbClient.query(
      'INSERT INTO experiment_participants (experiment_id, user_id, role) VALUES ($1, $2, $3)',
      [newExperimentId, creatorId, 'owner'],
    );

    await dbClient.query('COMMIT');

    return c.json({ experiment_id: newExperimentId, name, description, presentation_order }, 201);
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Failed to create experiment:', error);
    return c.json({ error: 'Database error while creating experiment' }, 500);
  } finally {
    dbClient.release();
  }
});

// GET /api/v1/experiments - 実験一覧の取得
experimentsRouter.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'X-User-Id header is required.' }, 400);
  }

  try {
    const participantResult = await dbPool.query(
      'SELECT experiment_id FROM experiment_participants WHERE user_id = $1',
      [userId],
    );

    if (participantResult.rows.length === 0) {
      return c.json([]);
    }

    const experimentIds = participantResult.rows.map((row) => row.experiment_id);

    const experimentsResult = await dbPool.query(
      'SELECT experiment_id, name, description, presentation_order FROM experiments WHERE experiment_id = ANY($1::uuid[]) ORDER BY name',
      [experimentIds],
    );

    return c.json(experimentsResult.rows);
  } catch (error) {
    console.error('Failed to get experiments:', error);
    return c.json({ error: 'Database error while fetching experiments' }, 500);
  }
});

// POST /:experiment_id/stimuli - 実験で使用する刺激アセットの登録
experimentsRouter.post('/:experiment_id/stimuli', requireAuth('owner'), async (c) => {
  const { experiment_id } = c.req.param();
  const formData = await c.req.formData();
  const csvFile = formData.get('stimuli_definition_csv') as File;
  const stimulusFiles = formData.getAll('stimulus_files') as File[];

  if (!csvFile || stimulusFiles.length === 0) {
    return c.json({ error: 'stimuli_definition_csv and stimulus_files are required.' }, 400);
  }

  try {
    const csvContent = await csvFile.text();
    const records: unknown[] = csvParse(csvContent, { columns: true, skip_empty_lines: true });
    const parsedCsv = z.array(stimulusCsvRowSchema).parse(records);

    const csvFileNames = new Set(parsedCsv.map((r) => r.file_name));
    const uploadedFileNames = new Set(stimulusFiles.map((f) => f.name));

    if (
      csvFileNames.size !== uploadedFileNames.size ||
      ![...csvFileNames].every((name) => uploadedFileNames.has(name))
    ) {
      return c.json({ error: 'Mismatch between file names in CSV and uploaded files.' }, 400);
    }

    const stimulusFilesPayload = await Promise.all(
      stimulusFiles.map(async (file) => ({
        fileName: file.name,
        mimeType: file.type,
        contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
      })),
    );

    const jobPayload = {
      experiment_id,
      csvDefinition: parsedCsv,
      files: stimulusFilesPayload,
    };

    getAmqpChannel().sendToQueue(
      config.STIMULUS_ASSET_QUEUE,
      Buffer.from(JSON.stringify(jobPayload)),
      { persistent: true },
    );
    console.log(`[RabbitMQ] Job enqueued for Stimulus Asset Processor: ${experiment_id}`);

    return c.json(
      { message: 'Stimuli registration request accepted and is being processed.' },
      202,
    );
  } catch (error) {
    console.error('Failed to process stimuli request:', error);
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid CSV format.', details: error.issues }, 400);
    }
    return c.json({ error: 'Failed to process stimuli registration request' }, 500);
  }
});

// GET /:experiment_id/stimuli - 実験で使用する刺激アセットの一覧を取得
experimentsRouter.get('/:experiment_id/stimuli', requireAuth('participant'), async (c) => {
  const { experiment_id } = c.req.param();
  try {
    const result = await dbPool.query(
      'SELECT stimulus_id, file_name, stimulus_type, trial_type, description FROM experiment_stimuli WHERE experiment_id = $1 ORDER BY file_name',
      [experiment_id],
    );
    return c.json(result.rows);
  } catch (error) {
    console.error('Failed to get stimuli for experiment:', error);
    return c.json({ error: 'Database error while fetching stimuli' }, 500);
  }
});

// BIDSエクスポートを開始するためのエンドポイント
experimentsRouter.post('/:experiment_id/export', requireAuth('owner'), async (c) => {
  const { experiment_id } = c.req.param();
  const userId = c.req.header('X-User-Id');

  try {
    const exportUrl = new URL(
      `/api/v1/experiments/${experiment_id}/export`,
      config.BIDS_EXPORTER_URL,
    );

    const response = await fetch(exportUrl.toString(), {
      method: 'POST',
      headers: {
        'X-User-Id': userId!,
      },
    });

    // ### <<< 修正点 >>> ###
    // response.ok で成功・失敗を判定し、どちらの場合も
    // 内部サービスからのレスポンスボディとステータスコードをそのまま転送する
    const responseBody = await response.json().catch(() => ({
      error: 'Upstream service returned a non-JSON or empty response.',
    }));

    // `response.status as any` を使ってTypeScriptのエラーを解消
    return c.json(responseBody, response.status as any);
  } catch (error) {
    console.error('Failed to forward request to BIDS exporter:', error);
    return c.json({ error: 'Service communication error' }, 503);
  }
});
