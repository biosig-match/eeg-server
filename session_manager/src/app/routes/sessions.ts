import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { parse as csvParse } from 'csv-parse/sync';
import { dbPool } from '../../infrastructure/db';
import { getAmqpChannel } from '../../infrastructure/queue';
import { sessionEndMetadataSchema, eventLogCsvRowSchema } from '../schemas/session';
import type { DataLinkerJobPayload } from '../types';
import { config } from '../../config/env';
import { requireAuth } from '../middleware/auth';
import type { ParsedBody, ParsedBodyRecord } from '../types/context';

export const sessionsRouter = new Hono();

const sessionStartMetadataSchema = sessionEndMetadataSchema.pick({
  session_id: true,
  user_id: true,
  experiment_id: true,
  start_time: true,
  session_type: true,
});

const isFormData = (value: ParsedBody): value is FormData =>
  typeof FormData !== 'undefined' && value instanceof FormData;

const extractSingleField = (source: ParsedBody, key: string): unknown => {
  if (isFormData(source)) {
    return source.get(key) ?? undefined;
  }
  const record = source as ParsedBodyRecord;
  const raw = record[key];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
};

const toStringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const toFileValue = (value: unknown): File | undefined => {
  if (typeof File !== 'undefined' && value instanceof File) {
    return value;
  }
  return undefined;
};

sessionsRouter.post(
  '/start',
  requireAuth('participant'),
  zValidator('json', sessionStartMetadataSchema),
  async (c) => {
    const metadata = c.req.valid('json');
    try {
      const query =
        'INSERT INTO sessions (session_id, user_id, experiment_id, start_time, session_type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (session_id) DO NOTHING';
      await dbPool.query(query, [
        metadata.session_id,
        metadata.user_id,
        metadata.experiment_id,
        metadata.start_time,
        metadata.session_type,
      ]);
      return c.json({ message: 'Session started successfully.' }, 201);
    } catch (error) {
      console.error('Failed to start session:', error);
      return c.json({ error: 'Database error while starting session.' }, 500);
    }
  },
);

sessionsRouter.post('/end', requireAuth('participant'), async (c) => {
  const cachedBody = c.get('parsedBody') as ParsedBody | undefined;
  const bodySource: ParsedBody = cachedBody ?? (await c.req.formData());

  const metadataRaw = extractSingleField(bodySource, 'metadata');
  const eventsRaw = extractSingleField(bodySource, 'events_log_csv');

  const metadataString = toStringValue(metadataRaw);

  if (!metadataString) {
    return c.json({ error: 'metadata field is required.' }, 400);
  }

  const eventsLogCsvFile = toFileValue(eventsRaw);
  const dbClient = await dbPool.connect();
  try {
    const metadata = sessionEndMetadataSchema.parse(JSON.parse(metadataString));

    await dbClient.query('BEGIN');

    const updateQuery =
      'UPDATE sessions SET end_time = $1, device_id = $2 WHERE session_id = $3 RETURNING session_type';
    const sessionUpdateResult = await dbClient.query(updateQuery, [
      metadata.end_time,
      metadata.device_id,
      metadata.session_id,
    ]);

    if (sessionUpdateResult.rowCount === 0) {
      throw new Error(`Session with ID ${metadata.session_id} not found for update.`);
    }
    const sessionType = sessionUpdateResult.rows[0].session_type;

    if (eventsLogCsvFile) {
      const existingEvents = await dbClient.query(
        'SELECT COUNT(*) FROM session_events WHERE session_id = $1',
        [metadata.session_id],
      );
      if (parseInt(existingEvents.rows[0].count, 10) > 0) {
        await dbClient.query('DELETE FROM session_events WHERE session_id = $1', [
          metadata.session_id,
        ]);
      }

      const csvContent = await eventsLogCsvFile.text();
      const records: unknown[] = csvParse(csvContent, { columns: true, skip_empty_lines: true });
      const parsedCsv = z.array(eventLogCsvRowSchema).parse(records);

      const stimuliResult = await dbClient.query(
        'SELECT stimulus_id, file_name FROM experiment_stimuli WHERE experiment_id = $1',
        [metadata.experiment_id],
      );
      const stimulusNameToIdMap = new Map<string, number>();
      for (const stim of stimuliResult.rows) {
        stimulusNameToIdMap.set(stim.file_name, stim.stimulus_id);
      }

      for (const row of parsedCsv) {
        if (row.onset === undefined || row.onset === null) {
          throw new Error(
            `Event missing required 'onset' field (BIDS requirement). Event data: ${JSON.stringify(row)}`,
          );
        }

        let stimulusId: number | null = null;
        let calibrationItemId: number | null = null;

        if (row.file_name && row.file_name !== 'n/a') {
          if (sessionType === 'calibration') {
            const calItemResult = await dbClient.query(
              'SELECT item_id FROM calibration_items WHERE file_name = $1',
              [row.file_name],
            );
            const calRowCount = calItemResult.rowCount ?? 0;
            if (calRowCount > 0 && calItemResult.rows[0]) {
              calibrationItemId = calItemResult.rows[0].item_id;
            }
          } else {
            const mappedStimulusId = stimulusNameToIdMap.get(row.file_name);
            if (mappedStimulusId !== undefined) {
              stimulusId = mappedStimulusId;
            }
          }
        }

        const insertEventQuery =
          'INSERT INTO session_events (session_id, stimulus_id, calibration_item_id, onset, duration, trial_type, description, value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
        await dbClient.query(insertEventQuery, [
          metadata.session_id,
          stimulusId,
          calibrationItemId,
          row.onset,
          row.duration ?? 0,
          row.trial_type,
          row.description || null,
          row.value || null,
        ]);
      }
    }
    await dbClient.query('COMMIT');

    const jobPayload: DataLinkerJobPayload = {
      session_id: metadata.session_id,
    };
    try {
      getAmqpChannel().sendToQueue(
        config.DATA_LINKER_QUEUE,
        Buffer.from(JSON.stringify(jobPayload)),
        { persistent: true },
      );
      console.log(`[RabbitMQ] Job enqueued for DataLinker: ${metadata.session_id}`);
    } catch (queueError) {
      console.error('CRITICAL: DB updated but failed to enqueue DataLinker job.', queueError);
      return c.json(
        {
          error:
            'Session data saved, but failed to queue background processing. Please notify administrator.',
        },
        500,
      );
    }
    return c.json({ message: 'Session ended and processed successfully' });
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Failed to end session:', error);
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid data format.', details: error.issues }, 400);
    }
    return c.json({ error: 'Failed to end session' }, 500);
  } finally {
    dbClient.release();
  }
});
