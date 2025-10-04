import { z } from 'zod';

// RabbitMQから受け取るジョブペイロードのスキーマ
export const eventCorrectorJobPayloadSchema = z.object({
  session_id: z.string().min(1, 'session_id is required.'),
});

export type EventCorrectorJobPayload = z.infer<typeof eventCorrectorJobPayloadSchema>;
