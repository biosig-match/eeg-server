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
  RABBITMQ_URL: z.string().url(),
  MEDIA_PROCESSING_QUEUE: z.string().min(1).default('media_processing_queue'),
  MEDIA_PREFETCH: z.coerce.number().int().min(1).default(2),
  OBJECT_STORAGE_ENDPOINT: z.string().min(1).default('object-storage'),
  OBJECT_STORAGE_PORT: z.coerce.number().default(8333),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).default('storageadmin'),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).default('storageadmin'),
  OBJECT_STORAGE_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OBJECT_STORAGE_MEDIA_BUCKET: z.string().min(1).default('media'),
  PORT: z.coerce.number().default(3020),
})

const parsedEnv = envSchema.safeParse({
  DATABASE_URL: derivedDatabaseUrl,
  RABBITMQ_URL: derivedRabbitUrl,
  MEDIA_PROCESSING_QUEUE: rawEnv.MEDIA_PROCESSING_QUEUE,
  MEDIA_PREFETCH: rawEnv.MEDIA_PREFETCH,
  OBJECT_STORAGE_ENDPOINT: rawEnv.OBJECT_STORAGE_ENDPOINT,
  OBJECT_STORAGE_PORT: rawEnv.OBJECT_STORAGE_PORT,
  OBJECT_STORAGE_ACCESS_KEY: rawEnv.OBJECT_STORAGE_ACCESS_KEY,
  OBJECT_STORAGE_SECRET_KEY: rawEnv.OBJECT_STORAGE_SECRET_KEY,
  OBJECT_STORAGE_USE_SSL: rawEnv.OBJECT_STORAGE_USE_SSL,
  OBJECT_STORAGE_MEDIA_BUCKET: rawEnv.OBJECT_STORAGE_MEDIA_BUCKET,
  PORT: rawEnv.PORT,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
