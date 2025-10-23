import { z } from 'zod'

const rawEnv = Bun.env

const envSchema = z.object({
  PORT: z.coerce.number().default(9000),
  POSTGRES_HOST: z.string().default('db'),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_DB: z.string(),
  RABBITMQ_HOST: z.string().default('rabbitmq'),
  RABBITMQ_MANAGEMENT_PORT: z.coerce.number().default(15672),
  RABBITMQ_USER: z.string(),
  RABBITMQ_PASSWORD: z.string(),
  RAW_DATA_EXCHANGE: z.string().default('raw_data_exchange'),
  PROCESSING_QUEUE: z.string().default('processing_queue'),
  MEDIA_PROCESSING_QUEUE: z.string().default('media_processing_queue'),
  DATA_LINKER_QUEUE: z.string().default('data_linker_queue'),
  EVENT_CORRECTION_QUEUE: z.string().default('event_correction_queue'),
  STIMULUS_ASSET_QUEUE: z.string().default('stimulus_asset_queue'),
  OBJECT_STORAGE_ENDPOINT: z.string().default('object-storage'),
  OBJECT_STORAGE_PORT: z.coerce.number().default(8333),
  OBJECT_STORAGE_ACCESS_KEY: z.string(),
  OBJECT_STORAGE_SECRET_KEY: z.string(),
  OBJECT_STORAGE_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OBJECT_STORAGE_RAW_DATA_BUCKET: z.string().default('raw-data'),
  OBJECT_STORAGE_MEDIA_BUCKET: z.string().default('media'),
  OBJECT_STORAGE_BIDS_EXPORTS_BUCKET: z.string().default('bids-exports'),
  SERVICE_TIMEOUT_MS: z.coerce.number().default(2000),
  DASHBOARD_REFRESH_INTERVAL_MS: z.coerce.number().default(4000),
  OBSERVABILITY_BASIC_USER: z.string(),
  OBSERVABILITY_BASIC_PASSWORD: z.string(),
  OBSERVABILITY_BASIC_REALM: z.string().default('Observability Dashboard'),
})

const parsedEnv = envSchema.safeParse({
  PORT: rawEnv.PORT,
  POSTGRES_HOST: rawEnv.POSTGRES_HOST,
  POSTGRES_USER: rawEnv.POSTGRES_USER,
  POSTGRES_PASSWORD: rawEnv.POSTGRES_PASSWORD,
  POSTGRES_DB: rawEnv.POSTGRES_DB,
  RABBITMQ_HOST: rawEnv.RABBITMQ_HOST,
  RABBITMQ_MANAGEMENT_PORT: rawEnv.RABBITMQ_MGMT_PORT ?? rawEnv.RABBITMQ_MANAGEMENT_PORT,
  RABBITMQ_USER: rawEnv.RABBITMQ_USER,
  RABBITMQ_PASSWORD: rawEnv.RABBITMQ_PASSWORD,
  RAW_DATA_EXCHANGE: rawEnv.RAW_DATA_EXCHANGE,
  PROCESSING_QUEUE: rawEnv.PROCESSING_QUEUE,
  MEDIA_PROCESSING_QUEUE: rawEnv.MEDIA_PROCESSING_QUEUE,
  DATA_LINKER_QUEUE: rawEnv.DATA_LINKER_QUEUE,
  EVENT_CORRECTION_QUEUE: rawEnv.EVENT_CORRECTION_QUEUE,
  STIMULUS_ASSET_QUEUE: rawEnv.STIMULUS_ASSET_QUEUE,
  OBJECT_STORAGE_ENDPOINT: rawEnv.OBJECT_STORAGE_ENDPOINT,
  OBJECT_STORAGE_PORT: rawEnv.OBJECT_STORAGE_PORT,
  OBJECT_STORAGE_ACCESS_KEY: rawEnv.OBJECT_STORAGE_ACCESS_KEY,
  OBJECT_STORAGE_SECRET_KEY: rawEnv.OBJECT_STORAGE_SECRET_KEY,
  OBJECT_STORAGE_USE_SSL: rawEnv.OBJECT_STORAGE_USE_SSL,
  OBJECT_STORAGE_RAW_DATA_BUCKET: rawEnv.OBJECT_STORAGE_RAW_DATA_BUCKET,
  OBJECT_STORAGE_MEDIA_BUCKET: rawEnv.OBJECT_STORAGE_MEDIA_BUCKET,
  OBJECT_STORAGE_BIDS_EXPORTS_BUCKET: rawEnv.OBJECT_STORAGE_BIDS_EXPORTS_BUCKET,
  SERVICE_TIMEOUT_MS: rawEnv.SERVICE_TIMEOUT_MS,
  DASHBOARD_REFRESH_INTERVAL_MS: rawEnv.DASHBOARD_REFRESH_INTERVAL_MS,
  OBSERVABILITY_BASIC_USER: rawEnv.OBSERVABILITY_BASIC_USER,
  OBSERVABILITY_BASIC_PASSWORD: rawEnv.OBSERVABILITY_BASIC_PASSWORD,
  OBSERVABILITY_BASIC_REALM: rawEnv.OBSERVABILITY_BASIC_REALM,
})

if (!parsedEnv.success) {
  const sensitiveFields = new Set([
    'POSTGRES_PASSWORD',
    'RABBITMQ_PASSWORD',
    'OBJECT_STORAGE_SECRET_KEY',
    'OBSERVABILITY_BASIC_PASSWORD',
  ])
  const fieldErrors = parsedEnv.error.flatten().fieldErrors
  const sanitizedErrors = Object.fromEntries(
    Object.entries(fieldErrors).map(([key, messages]) => [
      key,
      sensitiveFields.has(key) ? ['[REDACTED]'] : messages,
    ]),
  )
  console.error('❌ Invalid environment variables:', sanitizedErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data

export const DATABASE_URL = `postgres://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@${config.POSTGRES_HOST}:5432/${config.POSTGRES_DB}`

export const RABBITMQ_MANAGEMENT_URL = `http://${config.RABBITMQ_HOST}:${config.RABBITMQ_MANAGEMENT_PORT}`

export function getSafeConnectionString(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return '[INVALID_URL]'
  }
}
