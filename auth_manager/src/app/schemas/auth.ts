import { z } from 'zod';

// 参加者のロールとして許可される文字列のEnum
export const participantRoleSchema = z.enum(['owner', 'participant']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

// POST /api/v1/auth/experiments/{experiment_id}/join のリクエストボディ
export const joinExperimentSchema = z.object({
  user_id: z.string().min(1),
  password: z.string().optional(), // パスワードは任意
});

// PUT /api/v1/auth/experiments/{experiment_id}/participants/{user_id} のリクエストボディ
export const updateRoleSchema = z.object({
  role: participantRoleSchema,
});

// POST /api/v1/auth/check のリクエストボディ
export const authCheckSchema = z.object({
  user_id: z.string().min(1),
  experiment_id: z.string().uuid(),
  required_role: participantRoleSchema,
});
