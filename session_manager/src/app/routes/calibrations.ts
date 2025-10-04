import { Hono } from 'hono';
import { dbPool } from '../../infrastructure/db';
// ### <<< 修正点 >>> ###
// requireAuth の代わりに新しい requireUser をインポート
import { requireUser } from '../middleware/auth';

/**
 * ルーターのセットアップ
 * このルーターは、どの実験にも属さないグローバルなキャリブレーションアセットを管理します。
 */
export const calibrationsRouter = new Hono();

/**
 * GET /api/v1/calibrations
 * サーバーに登録されている全てのキャリブレーション用アセットのリストを取得します。
 * 認証されたユーザー（X-User-Idを持つユーザー）のみがアクセスできます。
 */
// ### <<< 修正点 >>> ###
// ミドルウェアを requireAuth('participant') から requireUser() に変更
calibrationsRouter.get('/', requireUser(), async (c) => {
  // エラーの原因となっていた行は不要なため削除
  try {
    const result = await dbPool.query(
      'SELECT item_id, file_name, item_type, description FROM calibration_items ORDER BY file_name',
    );
    return c.json(result.rows);
  } catch (error) {
    console.error('Failed to get calibration items:', error);
    return c.json({ error: 'Database error while fetching calibration items' }, 500);
  }
});
