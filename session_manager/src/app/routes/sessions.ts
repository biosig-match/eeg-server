import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { parse as csvParse } from 'csv-parse/sync';
import { dbPool } from '../../infrastructure/db';
import { getAmqpChannel } from '../../infrastructure/queue';
import {
  sessionEndMetadataSchema,
  eventLogCsvRowSchema,
  clockOffsetInfoSchema,
} from '../schemas/session';
import type { DataLinkerJobPayload } from '../types';
import { config } from '../../config/env';
import { requireUser } from '../middleware/auth';
import type { ParsedBody, ParsedBodyRecord } from '../types/context';
import type { ParticipantRole } from '../schemas/auth';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const sessionsRouter = new Hono();

const sessionStartMetadataSchema = sessionEndMetadataSchema.pick({
  session_id: true,
  user_id: true,
  experiment_id: true,
  start_time: true,
  session_type: true,
}).extend({
  clock_offset_info: clockOffsetInfoSchema,
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

type HttpError = Error & { status?: number };

const ensureExperimentRole = async (
  userId: string,
  experimentId: string,
  requiredRole: ParticipantRole,
): Promise<void> => {
  const authUrl = new URL('/api/v1/auth/check', config.AUTH_MANAGER_URL);

  let response: Response;
  try {
    response = await fetch(authUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        experiment_id: experimentId,
        required_role: requiredRole,
      }),
    });
  } catch (error) {
    const err = new Error('Failed to reach authorization service.') as HttpError;
    err.status = 503;
    throw err;
  }

  let payload: any = null;
  const isJson = response.headers.get('content-type')?.includes('application/json');
  if (isJson) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const err = new Error(
      payload?.error ?? `Authorization service returned status ${response.status}.`,
    ) as HttpError;
    err.status = response.status === 403 || response.status === 404 ? response.status : 503;
    throw err;
  }

  if (!payload || typeof payload.authorized !== 'boolean') {
    const err = new Error('Authorization service returned an unexpected payload.') as HttpError;
    err.status = 503;
    throw err;
  }

  if (!payload.authorized) {
    const err = new Error('Forbidden') as HttpError;
    err.status = 403;
    throw err;
  }
};

sessionsRouter.post(
  '/start',
  requireUser(),
  zValidator('json', sessionStartMetadataSchema),
  async (c) => {
    const metadata = c.req.valid('json');
    const requesterId = c.req.header('X-User-Id');

    if (!requesterId) {
      return c.json({ error: 'Unauthorized' }, 401 as const);
    }

    if (metadata.user_id !== requesterId) {
      return c.json({ error: 'user_id does not match authenticated user.' }, 403 as const);
    }

    if (metadata.experiment_id) {
      try {
        await ensureExperimentRole(requesterId, metadata.experiment_id, 'participant');
      } catch (error) {
        const err = error as HttpError;
        const status = (err.status ?? 500) as ContentfulStatusCode;
        return c.json({ error: err.message }, status);
      }
    }

    try {
      const query =
        'INSERT INTO sessions (session_id, user_id, experiment_id, start_time, session_type, clock_offset_info) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (session_id) DO NOTHING RETURNING session_id';
      const result = await dbPool.query(query, [
        metadata.session_id,
        requesterId,
        metadata.experiment_id ?? null,
        metadata.start_time,
        metadata.session_type,
        metadata.clock_offset_info ?? null,
      ]);
      if (result.rowCount === 0) {
        const existingSession = await dbPool.query(
          'SELECT user_id FROM sessions WHERE session_id = $1',
          [metadata.session_id],
        );

        const existingOwner = existingSession.rows[0]?.user_id as string | null | undefined;
        if (existingOwner && existingOwner !== requesterId) {
          return c.json(
            { error: 'Session ID already exists and belongs to another user.' },
            409 as const,
          );
        }

        return c.json({ message: 'Session already exists.' }, 200 as const);
      }

      return c.json({ message: 'Session started successfully.' }, 201 as const);
    } catch (error) {
      console.error('Failed to start session:', error);
      return c.json({ error: 'Database error while starting session.' }, 500 as const);
    }
  },
);

sessionsRouter.post('/end', requireUser(), async (c) => {
  const cachedBody = c.get('parsedBody') as ParsedBody | undefined;
  const bodySource: ParsedBody = cachedBody ?? (await c.req.formData());

  const metadataRaw = extractSingleField(bodySource, 'metadata');
  const eventsRaw = extractSingleField(bodySource, 'events_log_csv');

  const metadataString = toStringValue(metadataRaw);

  if (!metadataString) {
    return c.json({ error: 'metadata field is required.' }, 400 as const);
  }

  const requesterId = c.req.header('X-User-Id');
  if (!requesterId) {
    return c.json({ error: 'Unauthorized' }, 401 as const);
  }

  const eventsLogCsvFile = toFileValue(eventsRaw);
  const dbClient = await dbPool.connect();
  let releaseDestroyedClient = false;
  try {
    const metadata = sessionEndMetadataSchema.parse(JSON.parse(metadataString));

    if (metadata.user_id !== requesterId) {
      return c.json({ error: 'user_id does not match authenticated user.' }, 403 as const);
    }

    const existingSession = await dbClient.query(
      'SELECT experiment_id, user_id FROM sessions WHERE session_id = $1',
      [metadata.session_id],
    );

    if (existingSession.rowCount === 0) {
      return c.json({ error: `Session ${metadata.session_id} not found.` }, 404 as const);
    }

    const sessionRow = existingSession.rows[0];
    if (sessionRow.user_id && sessionRow.user_id !== requesterId) {
      return c.json({ error: 'You are not allowed to modify this session.' }, 403 as const);
    }

    const experimentIdForAuth: string | undefined =
      metadata.experiment_id ?? (sessionRow.experiment_id as string | null) ?? undefined;

    if (experimentIdForAuth) {
      try {
        await ensureExperimentRole(requesterId, experimentIdForAuth, 'participant');
      } catch (error) {
        const err = error as HttpError;
        const status = (err.status ?? 500) as ContentfulStatusCode;
        return c.json({ error: err.message }, status);
      }
    }

    await dbClient.query('BEGIN');

    const updateQuery = `
      UPDATE sessions
      SET end_time = $1,
          device_id = $2,
          clock_offset_info = COALESCE($4, clock_offset_info),
          experiment_id = COALESCE($5, experiment_id)
      WHERE session_id = $3
      RETURNING session_type, experiment_id
    `;
    const sessionUpdateResult = await dbClient.query(updateQuery, [
      metadata.end_time,
      metadata.device_id,
      metadata.session_id,
      metadata.clock_offset_info ?? null,
      metadata.experiment_id ?? null,
    ]);

    if (sessionUpdateResult.rowCount === 0) {
      throw new Error(`Session with ID ${metadata.session_id} not found for update.`);
    }
    const sessionType = sessionUpdateResult.rows[0].session_type as string;
    const effectiveExperimentId: string | undefined =
      metadata.experiment_id ?? (sessionUpdateResult.rows[0].experiment_id as string | null) ?? undefined;

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

      let stimulusNameToIdMap: Map<string, number> | undefined;
      if (effectiveExperimentId) {
        const stimuliResult = await dbClient.query(
          'SELECT stimulus_id, file_name FROM experiment_stimuli WHERE experiment_id = $1',
          [effectiveExperimentId],
        );
        stimulusNameToIdMap = new Map<string, number>();
        for (const stim of stimuliResult.rows) {
          stimulusNameToIdMap.set(stim.file_name, stim.stimulus_id);
        }
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
            const mappedStimulusId = stimulusNameToIdMap?.get(row.file_name);
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
        500 as const,
      );
    }
    return c.json({ message: 'Session ended and processed successfully' });
  } catch (error) {
    try {
      await dbClient.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to rollback transaction. Destroying connection.', rollbackError);
      dbClient.release(true);
      releaseDestroyedClient = true;
    }
    console.error('Failed to end session:', error);
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid data format.', details: error.issues }, 400 as const);
    }
    return c.json({ error: 'Failed to end session' }, 500 as const);
  } finally {
    if (!releaseDestroyedClient) {
      dbClient.release();
    }
  }
});
