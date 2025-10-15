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
  MINIO_ENDPOINT: z.string().default('minio'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  MINIO_RAW_DATA_BUCKET: z.string().default('raw-data'),
  MINIO_MEDIA_BUCKET: z.string().default('media'),
  MINIO_BIDS_EXPORTS_BUCKET: z.string().default('bids-exports'),
  SERVICE_TIMEOUT_MS: z.coerce.number().default(2000),
  DASHBOARD_REFRESH_INTERVAL_MS: z.coerce.number().default(4000),
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
  MINIO_ENDPOINT: rawEnv.MINIO_ENDPOINT,
  MINIO_PORT: rawEnv.MINIO_PORT,
  MINIO_ACCESS_KEY: rawEnv.MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY: rawEnv.MINIO_SECRET_KEY,
  MINIO_USE_SSL: rawEnv.MINIO_USE_SSL,
  MINIO_RAW_DATA_BUCKET: rawEnv.MINIO_RAW_DATA_BUCKET,
  MINIO_MEDIA_BUCKET: rawEnv.MINIO_MEDIA_BUCKET,
  MINIO_BIDS_EXPORTS_BUCKET: rawEnv.MINIO_BIDS_EXPORTS_BUCKET,
  SERVICE_TIMEOUT_MS: rawEnv.SERVICE_TIMEOUT_MS,
  DASHBOARD_REFRESH_INTERVAL_MS: rawEnv.DASHBOARD_REFRESH_INTERVAL_MS,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data

export const DATABASE_URL = `postgres://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@${config.POSTGRES_HOST}:5432/${config.POSTGRES_DB}`

export const RABBITMQ_MANAGEMENT_URL = `http://${config.RABBITMQ_HOST}:${config.RABBITMQ_MANAGEMENT_PORT}`
