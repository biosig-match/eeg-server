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
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  MINIO_RAW_DATA_BUCKET: z.string().min(1),
  SAMPLE_RATE: z.coerce.number().default(500),
  PORT: z.coerce.number().default(3040),
})

const parsedEnv = envSchema.safeParse({
  DATABASE_URL: derivedDatabaseUrl,
  RABBITMQ_URL: derivedRabbitUrl,
  EVENT_CORRECTION_QUEUE: rawEnv.EVENT_CORRECTION_QUEUE,
  MINIO_ENDPOINT: rawEnv.MINIO_ENDPOINT ?? 'minio',
  MINIO_PORT: rawEnv.MINIO_PORT ?? '9000',
  MINIO_ACCESS_KEY: rawEnv.MINIO_ACCESS_KEY ?? 'minioadmin',
  MINIO_SECRET_KEY: rawEnv.MINIO_SECRET_KEY ?? 'minioadmin',
  MINIO_USE_SSL: rawEnv.MINIO_USE_SSL ?? 'false',
  MINIO_RAW_DATA_BUCKET: rawEnv.MINIO_RAW_DATA_BUCKET ?? 'raw-data',
  SAMPLE_RATE: rawEnv.SAMPLE_RATE ?? '500',
  PORT: rawEnv.PORT,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
