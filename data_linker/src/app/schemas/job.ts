import { z } from 'zod';

export const dataLinkerJobPayloadSchema = z.object({
  session_id: z.string().min(1),
});

export type DataLinkerJobPayload = z.infer<typeof dataLinkerJobPayloadSchema>;
