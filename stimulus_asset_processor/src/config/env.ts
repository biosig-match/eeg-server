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
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  MINIO_MEDIA_BUCKET: z.string().min(1),
  RABBITMQ_URL: z.string().url(),
  STIMULUS_ASSET_QUEUE: z.string().min(1),
  PORT: z.coerce.number().default(3050),
})

const parsedEnv = envSchema.safeParse({
  DATABASE_URL: derivedDatabaseUrl,
  MINIO_ENDPOINT: rawEnv.MINIO_ENDPOINT ?? 'minio',
  MINIO_PORT: rawEnv.MINIO_PORT ?? '9000',
  MINIO_ACCESS_KEY: rawEnv.MINIO_ACCESS_KEY ?? 'minioadmin',
  MINIO_SECRET_KEY: rawEnv.MINIO_SECRET_KEY ?? 'minioadmin',
  MINIO_USE_SSL: rawEnv.MINIO_USE_SSL ?? 'false',
  MINIO_MEDIA_BUCKET: rawEnv.MINIO_MEDIA_BUCKET ?? 'media',
  RABBITMQ_URL: derivedRabbitUrl,
  STIMULUS_ASSET_QUEUE: rawEnv.STIMULUS_ASSET_QUEUE ?? 'stimulus_asset_queue',
  PORT: rawEnv.PORT,
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
