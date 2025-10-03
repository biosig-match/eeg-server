import { z } from 'zod'

const rawEnv = Bun.env

const derivedRabbitUrl =
  rawEnv.RABBITMQ_URL ??
  (rawEnv.RABBITMQ_USER && rawEnv.RABBITMQ_PASSWORD && rawEnv.RABBITMQ_HOST
    ? `amqp://${rawEnv.RABBITMQ_USER}:${rawEnv.RABBITMQ_PASSWORD}@${rawEnv.RABBITMQ_HOST}`
    : undefined)

const envSchema = z.object({
  RABBITMQ_URL: z.string().url(),
  RAW_DATA_EXCHANGE: z.string().min(1).default('raw_data_exchange'),
  MEDIA_PROCESSING_QUEUE: z.string().min(1).default('media_processing_queue'),
  PORT: z.coerce.number().default(3000),
})

const parsedEnv = envSchema.safeParse({
  RABBITMQ_URL: derivedRabbitUrl,
  RAW_DATA_EXCHANGE: rawEnv.RAW_DATA_EXCHANGE ?? 'raw_data_exchange',
  MEDIA_PROCESSING_QUEUE: rawEnv.MEDIA_PROCESSING_QUEUE ?? 'media_processing_queue',
  PORT: rawEnv.PORT ?? '3000',
})

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables.')
}

export const config = parsedEnv.data
