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
  EVENT_CORRECTION_QUEUE: z.string().min(1),
  OBJECT_STORAGE_ENDPOINT: z.string().min(1),
  OBJECT_STORAGE_PORT: z.coerce.number(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1),
  OBJECT_STORAGE_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OBJECT_STORAGE_RAW_DATA_BUCKET: z.string().min(1),
  SAMPLE_RATE: z.coerce.number().default(500),
  PORT: z.coerce.number().default(3040),
})

const parsedEnv = envSchema.safeParse({
  DATABASE_URL: derivedDatabaseUrl,
  RABBITMQ_URL: derivedRabbitUrl,
  EVENT_CORRECTION_QUEUE: rawEnv.EVENT_CORRECTION_QUEUE,
  OBJECT_STORAGE_ENDPOINT: rawEnv.OBJECT_STORAGE_ENDPOINT ?? 'object-storage',
  OBJECT_STORAGE_PORT: rawEnv.OBJECT_STORAGE_PORT ?? '8333',
  OBJECT_STORAGE_ACCESS_KEY: rawEnv.OBJECT_STORAGE_ACCESS_KEY ?? 'storageadmin',
  OBJECT_STORAGE_SECRET_KEY: rawEnv.OBJECT_STORAGE_SECRET_KEY ?? 'storageadmin',
  OBJECT_STORAGE_USE_SSL: rawEnv.OBJECT_STORAGE_USE_SSL ?? 'false',
  OBJECT_STORAGE_RAW_DATA_BUCKET: rawEnv.OBJECT_STORAGE_RAW_DATA_BUCKET ?? 'raw-data',
  SAMPLE_RATE: rawEnv.SAMPLE_RATE ?? '500',
  PORT: rawEnv.PORT,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
