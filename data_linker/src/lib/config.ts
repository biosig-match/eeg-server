import { z } from 'zod';

/**
 * Environment variables schema for type-safe configuration.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  DATA_LINKER_QUEUE: z.string().default('data_linker_queue'),
  EVENT_CORRECTION_QUEUE: z.string(),
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
