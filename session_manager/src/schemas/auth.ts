import { z } from 'zod';

/**
 * 実験参加者が取りうるロール（役割）を定義するZodスキーマ。
 * この定義は `Auth Manager` サービスのスキーマと一致している必要があります。
 */
export const participantRoleSchema = z.enum(['owner', 'participant']);

/**
 * Zodスキーマから推論されたTypeScriptの型。
 * ミドルウェアなどで型注釈として使用します。
 * e.g. `const role: ParticipantRole = 'owner';`
 */
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
