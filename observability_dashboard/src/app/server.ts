import { z } from 'zod'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'

import { config } from '../config/env'
import { buildGraphSnapshot } from './services/graph'
import {
  TableSample,
  describeTableColumns,
  listExportTasks,
  listUserTables,
  pgPool,
  readTableSample,
} from './services/database'
import { checkMinioHealth } from './services/storage'
import { readRabbitStatus } from './services/rabbitmq'
import { buildDashboardHtml } from './ui/dashboard'

const app = new Hono()

function startRequestLog(method: string, path: string) {
  const startedAt = Date.now()
  console.info(`[observability] <= ${method} ${path}`)
  return (status: number, details?: string) => {
    const elapsed = Date.now() - startedAt
    console.info(
      `[observability] => ${method} ${path} [${status}] ${elapsed}ms${details ? ` ${details}` : ''}`,
    )
  }
}

const tableParamSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
})

const limitQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number.parseInt(value, 10) : undefined))
    .refine((value) => value === undefined || (Number.isInteger(value) && value > 0 && value <= 500), {
      message: 'limit must be between 1 and 500',
    }),
})

app.get('/health', async (c) => {
  const done = startRequestLog('GET', '/health')
  const [rabbit, db, minio] = await Promise.all([readRabbitStatus(), pgHealth(), checkMinioHealth(3)])
  const healthy = rabbit.healthy && db.healthy && minio.healthy
  done(healthy ? 200 : 503, `rabbit=${rabbit.healthy} db=${db.healthy} minio=${minio.healthy}`)
  return c.json(
    {
      status: healthy ? 'ok' : 'degraded',
      rabbitmq: rabbit,
      postgres: db,
      minio: {
        healthy: minio.healthy,
        error: minio.error,
        checkedAt: minio.checkedAt,
      },
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  )
})

app.get('/', (c) => {
  const done = startRequestLog('GET', '/')
  const html = buildDashboardHtml({
    refreshIntervalMs: config.DASHBOARD_REFRESH_INTERVAL_MS,
  })
  done(200)
  return c.html(html)
})

app.get('/api/v1/graph', async (c) => {
  const done = startRequestLog('GET', '/api/v1/graph')
  try {
    const snapshot = await buildGraphSnapshot()
    done(200, `nodes=${snapshot.nodes.length} edges=${snapshot.edges.length}`)
    return c.json(snapshot)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build graph snapshot'
    console.error('❌ Failed to build graph snapshot:', error)
    const now = new Date().toISOString()
    done(200, `error=${message}`)
    return c.json({
      generatedAt: now,
      error: message,
      nodes: [],
      edges: [],
      rabbit: { healthy: false, error: message, checkedAt: now },
      postgres: { healthy: false, error: message, checkedAt: now },
      minio: { healthy: false, error: message, checkedAt: now, buckets: [] },
    })
  }
})

app.get('/api/v1/db/tables', async (c) => {
  const done = startRequestLog('GET', '/api/v1/db/tables')
  try {
    const tables = await listUserTables()
    done(200, `tables=${tables.length}`)
    return c.json({
      generatedAt: new Date().toISOString(),
      tables,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list tables'
    console.error('❌ Failed to list database tables:', error)
    done(200, `error=${message}`)
    return c.json({
      generatedAt: new Date().toISOString(),
      tables: [],
      error: message,
    })
  }
})

app.get('/api/v1/db/tables/:schema/:table/columns', zValidator('param', tableParamSchema), async (c) => {
  const { schema, table } = c.req.valid('param')
  const done = startRequestLog('GET', `/api/v1/db/tables/${schema}/${table}/columns`)
  const columns = await describeTableColumns(schema, table)
  done(200, `columns=${columns.length}`)
  return c.json({
    schema,
    table,
    columns,
    generatedAt: new Date().toISOString(),
  })
})

app.get(
  '/api/v1/db/tables/:schema/:table',
  zValidator('param', tableParamSchema),
  zValidator('query', limitQuerySchema),
  async (c) => {
    const { schema, table } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    const done = startRequestLog('GET', `/api/v1/db/tables/${schema}/${table}`)
    try {
      const rows: TableSample = await readTableSample(schema, table, limit ?? 50)
      done(200, `rows=${rows.rows.length}`)
      return c.json({
        schema,
        table,
        limit: limit ?? 50,
        ...rows,
        generatedAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read table sample'
      console.error(`❌ Failed to read table sample for ${schema}.${table}:`, error)
      done(200, `error=${message}`)
      return c.json({
        schema,
        table,
        limit: limit ?? 50,
        columns: [],
        rows: [],
        error: message,
        generatedAt: new Date().toISOString(),
      })
    }
  },
)

app.get('/api/v1/tasks', zValidator('query', limitQuerySchema), async (c) => {
  const { limit } = c.req.valid('query')
  const done = startRequestLog('GET', '/api/v1/tasks')
  try {
    const tasks = await listExportTasks(limit ?? 100)
    done(200, `tasks=${tasks.length}`)
    return c.json({
      generatedAt: new Date().toISOString(),
      tasks,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load export tasks'
    console.error('❌ Failed to load export tasks:', error)
    done(200, `error=${message}`)
    return c.json({
      generatedAt: new Date().toISOString(),
      tasks: [],
      error: message,
    })
  }
})

app.get('/api/v1/storage/buckets', async (c) => {
  const done = startRequestLog('GET', '/api/v1/storage/buckets')
  try {
    const overview = await checkMinioHealth(50)
    done(200, `buckets=${overview.buckets.length}`)
    return c.json(overview)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to query MinIO'
    console.error('❌ Failed to query MinIO buckets:', error)
    const now = new Date().toISOString()
    done(200, `error=${message}`)
    return c.json({
      healthy: false,
      checkedAt: now,
      buckets: [],
      error: message,
    })
  }
})

app.notFound((c) =>
  c.json(
    {
      message: `Route ${c.req.method} ${c.req.path} does not exist.`,
    },
    404,
  ),
)

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ Observability dashboard encountered an unhandled error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

export async function startObservabilityService() {
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  })
  console.log(`🚀 Observability dashboard listening on port ${server.port}`)

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`⚠️  Shutting down observability dashboard (${signal})`)
    await server.stop()
    await pgPool.end()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return server
}

async function pgHealth() {
  return pgPool
    .query('SELECT NOW()')
    .then(() => ({
      healthy: true,
      checkedAt: new Date().toISOString(),
    }))
    .catch((error) => ({
      healthy: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'database check failed',
    }))
}
