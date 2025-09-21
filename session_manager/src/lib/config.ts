import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  MINIO_ENDPOINT: z.string(),
  MINIO_PORT: z.coerce.number(),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  MINIO_USE_SSL: z
    .string()
    .transform((s) => s === 'true')
    .default('false'),
  MINIO_MEDIA_BUCKET: z.string(),
  RABBITMQ_URL: z.string().url(),
  DATA_LINKER_QUEUE: z.string(),
  STIMULUS_ASSET_QUEUE: z.string(),
  AUTH_MANAGER_URL: z.string().url(),
});

const parsedEnv = envSchema.safeParse({
  ...process.env,
  DATABASE_URL: `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:5432/${process.env.POSTGRES_DB}`,
  RABBITMQ_URL: `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}`,
});

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables.');
}

export const config = parsedEnv.data;
