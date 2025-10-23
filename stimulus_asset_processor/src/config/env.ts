import { z } from 'zod'

const rawEnv = Bun.env

const derivedDatabaseUrl =
  rawEnv.DATABASE_URL ??
  (rawEnv.POSTGRES_USER &&
  rawEnv.POSTGRES_PASSWORD &&
  rawEnv.POSTGRES_HOST &&
  rawEnv.POSTGRES_DB
    ? `postgres://${rawEnv.POSTGRES_USER}:${rawEnv.POSTGRES_PASSWORD}@${rawEnv.POSTGRES_HOST}:5432/${rawEnv.POSTGRES_DB}`
    : undefined)

const derivedRabbitUrl =
  rawEnv.RABBITMQ_URL ??
  (rawEnv.RABBITMQ_USER && rawEnv.RABBITMQ_PASSWORD && rawEnv.RABBITMQ_HOST
    ? `amqp://${rawEnv.RABBITMQ_USER}:${rawEnv.RABBITMQ_PASSWORD}@${rawEnv.RABBITMQ_HOST}`
    : undefined)

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OBJECT_STORAGE_ENDPOINT: z.string().min(1).default('object-storage'),
  OBJECT_STORAGE_PORT: z.coerce.number().default(8333),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).default('storageadmin'),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).default('storageadmin'),
  OBJECT_STORAGE_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OBJECT_STORAGE_MEDIA_BUCKET: z.string().min(1).default('media'),
  RABBITMQ_URL: z.string().url(),
  STIMULUS_ASSET_QUEUE: z.string().min(1).default('stimulus_asset_queue'),
  PORT: z.coerce.number().default(3050),
})

const parsedEnv = envSchema.safeParse({
  DATABASE_URL: derivedDatabaseUrl,
  OBJECT_STORAGE_ENDPOINT: rawEnv.OBJECT_STORAGE_ENDPOINT,
  OBJECT_STORAGE_PORT: rawEnv.OBJECT_STORAGE_PORT,
  OBJECT_STORAGE_ACCESS_KEY: rawEnv.OBJECT_STORAGE_ACCESS_KEY,
  OBJECT_STORAGE_SECRET_KEY: rawEnv.OBJECT_STORAGE_SECRET_KEY,
  OBJECT_STORAGE_USE_SSL: rawEnv.OBJECT_STORAGE_USE_SSL,
  OBJECT_STORAGE_MEDIA_BUCKET: rawEnv.OBJECT_STORAGE_MEDIA_BUCKET,
  RABBITMQ_URL: derivedRabbitUrl,
  STIMULUS_ASSET_QUEUE: rawEnv.STIMULUS_ASSET_QUEUE,
  PORT: rawEnv.PORT,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
