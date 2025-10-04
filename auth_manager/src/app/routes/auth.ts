import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { dbPool } from '../../infrastructure/db';
import {
  joinExperimentSchema,
  updateRoleSchema,
  authCheckSchema,
  ParticipantRole,
} from '../schemas/auth';

export const authRouter = new Hono();

const isUserOwner = async (
  dbClient: any,
  userId: string,
  experimentId: string,
): Promise<boolean> => {
  const result = await dbClient.query(
    'SELECT 1 FROM experiment_participants WHERE experiment_id = $1 AND user_id = $2 AND role = $3',
    [experimentId, userId, 'owner'],
  );
  return result.rowCount > 0;
};

authRouter.post(
  '/experiments/:experiment_id/join',
  zValidator('json', joinExperimentSchema),
  async (c) => {
    const { experiment_id } = c.req.param();
    const { user_id, password } = c.req.valid('json');
    const dbClient = await dbPool.connect();
    try {
      const expResult = await dbClient.query(
        'SELECT password_hash FROM experiments WHERE experiment_id = $1',
        [experiment_id],
      );
      if (expResult.rowCount === 0) {
        return c.json({ error: 'Experiment not found' }, 404);
      }
      const { password_hash } = expResult.rows[0];
      if (password_hash) {
        if (!password) {
          return c.json({ error: 'Password is required for this experiment' }, 401);
        }
        const isValid = await Bun.password.verify(password, password_hash);
        if (!isValid) {
          return c.json({ error: 'Invalid password' }, 401);
        }
      }
      await dbClient.query(
        `INSERT INTO experiment_participants (experiment_id, user_id, role)
          VALUES ($1, $2, 'participant')
          ON CONFLICT (experiment_id, user_id) DO NOTHING`,
        [experiment_id, user_id],
      );
      return c.json({ message: 'Successfully joined experiment' }, 201);
    } catch (error) {
      console.error('Failed to join experiment:', error);
      return c.json({ error: 'Database error' }, 500);
    } finally {
      dbClient.release();
    }
  },
);

authRouter.get('/experiments/:experiment_id/participants', async (c) => {
  const { experiment_id } = c.req.param();
  const requester_id = c.req.header('X-User-Id');
  if (!requester_id) {
    return c.json({ error: 'X-User-Id header is required' }, 400);
  }

  const dbClient = await dbPool.connect();
  try {
    if (!(await isUserOwner(dbClient, requester_id, experiment_id))) {
      return c.json({ error: 'Forbidden: Only owners can view participants' }, 403);
    }
    const result = await dbClient.query(
      'SELECT user_id, role, joined_at FROM experiment_participants WHERE experiment_id = $1',
      [experiment_id],
    );
    return c.json(result.rows);
  } catch (error) {
    console.error('Failed to get participants:', error);
    return c.json({ error: 'Database error' }, 500);
  } finally {
    dbClient.release();
  }
});

authRouter.put(
  '/experiments/:experiment_id/participants/:user_id',
  zValidator('json', updateRoleSchema),
  async (c) => {
    const { experiment_id, user_id } = c.req.param();
    const requester_id = c.req.header('X-User-Id');
    if (!requester_id) {
      return c.json({ error: 'X-User-Id header is required' }, 400);
    }

    const { role } = c.req.valid('json');
    const dbClient = await dbPool.connect();
    try {
      if (!(await isUserOwner(dbClient, requester_id, experiment_id))) {
        return c.json({ error: 'Forbidden: Only owners can change roles' }, 403);
      }
      const result = await dbClient.query(
        'UPDATE experiment_participants SET role = $1 WHERE experiment_id = $2 AND user_id = $3 RETURNING *',
        [role, experiment_id, user_id],
      );
      if (result.rowCount === 0) {
        return c.json({ error: 'Participant not found' }, 404);
      }
      return c.json(result.rows[0]);
    } catch (error) {
      console.error('Failed to update role:', error);
      return c.json({ error: 'Database error' }, 500);
    } finally {
      dbClient.release();
    }
  },
);

authRouter.post('/check', zValidator('json', authCheckSchema), async (c) => {
  const { user_id, experiment_id, required_role } = c.req.valid('json');
  console.log(
    `[Auth Check] Received check for user: "${user_id}", experiment: "${experiment_id}", role: "${required_role}"`,
  );
  try {
    let authorizedRoles: ParticipantRole[] = [];
    if (required_role === 'owner') {
      authorizedRoles = ['owner'];
    } else if (required_role === 'participant') {
      authorizedRoles = ['owner', 'participant'];
    }

    if (authorizedRoles.length === 0) {
      console.log(
        `[Auth Check] No authorized roles found for required_role: ${required_role}. Denying.`,
      );
      return c.json({ authorized: false });
    }

    const query = {
      text: 'SELECT 1 FROM experiment_participants WHERE experiment_id = $1 AND user_id = $2 AND role = ANY($3::varchar[])',
      values: [experiment_id, user_id, authorizedRoles],
    };

    const result = await dbPool.query(query);
    const isAuthorized = (result.rowCount ?? 0) > 0;
    console.log(`[Auth Check] User "${user_id}" authorization result: ${isAuthorized}`);
    return c.json({ authorized: isAuthorized });
  } catch (error) {
    console.error('Authorization check failed:', error);
    return c.json({ error: 'Database error during authorization check' }, 500);
  }
});
