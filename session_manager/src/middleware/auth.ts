import { createMiddleware } from 'hono/factory';
import { config } from '../lib/config';
import { debugLog, warnLog, errorLog } from '../lib/logger';
import type { ParticipantRole } from '../schemas/auth';

/**
 * ユーザーが必要なロールを持っているかAuth Managerに問い合わせて検証するHonoミドルウェア
 *
 * @param requiredRole - 要求される最低限のロール ('owner' または 'participant')
 */
export const requireAuth = (requiredRole: ParticipantRole) => {
  return createMiddleware(async (c, next) => {
    // リクエストヘッダーからユーザーIDを取得
    const userId = c.req.header('X-User-Id');
    if (!userId) {
      return c.json({ error: 'Unauthorized: X-User-Id header is required.' }, 401);
    } // 実験IDをパスパラメータ、JSONボディ、またはフォームデータから取得

    let experimentId: string | undefined;

    experimentId = c.req.param('experiment_id');

    if (!experimentId) {
      const contentType = c.req.header('Content-Type') || '';
      debugLog(
        `[Auth Middleware] No experimentId in path. Attempting to find in body. Content-Type: "${contentType}"`,
      );

      try {
        let body: any;
        if (contentType.includes('application/json')) {
          body = await c.req.json();
        } else if (contentType.includes('multipart/form-data')) {
          body = await c.req.parseBody({ all: true });
        } else {
          warnLog(
            `[Auth Middleware] Unhandled Content-Type: "${contentType}". Attempting parseBody().`,
          );
          body = await c.req.parseBody({ all: true });
        }

        // パース済みボディをコンテキストにキャッシュして、後続のハンドラーで再利用可能にする
        c.set('parsedBody', body);

        debugLog('[Auth Middleware] Successfully parsed body. Keys:', Object.keys(body));
        debugLog('[Auth Middleware] Full parsed body:', JSON.stringify(body, null, 2));

        if (body && typeof (body as any).experiment_id === 'string') {
          experimentId = (body as any).experiment_id;
        } else if (body && (body as any).metadata) {
          const metadataValue = (body as any).metadata;
          const metadataString = Array.isArray(metadataValue) ? metadataValue[0] : metadataValue;

          if (typeof metadataString === 'string') {
            try {
              const metadata = JSON.parse(metadataString);
              if (metadata && typeof metadata.experiment_id === 'string') {
                experimentId = metadata.experiment_id;
              } else {
                warnLog(
                  '[Auth Middleware] Parsed metadata but "experiment_id" is missing or not a string.',
                );
              }
            } catch (jsonError) {
              errorLog(
                '[Auth Middleware] FAILED to parse metadata string as JSON.',
                jsonError,
              );
            }
          } else {
            warnLog(
              `[Auth Middleware] The 'metadata' part was not a string. Actual type: ${typeof metadataString}. Cannot extract experimentId.`,
            );
          }
        } else {
          warnLog(
            '[Auth Middleware] Parsed body, but neither "experiment_id" nor "metadata" field was found.',
          );
        }
      } catch (e) {
        errorLog('[Auth Middleware] CRITICAL: Error parsing request body:', e);
      }
    } // Auth Manager Serviceに権限チェックをリクエスト

    if (!experimentId) {
      errorLog('[Auth Middleware] FINAL CHECK FAILED: Could not extract experimentId.');
      errorLog(`[Auth Middleware] Path: ${c.req.path}, Method: ${c.req.method}`);
      return c.json({ error: 'Bad Request: experiment_id not found in path or body.' }, 400);
    }

    try {
      const authUrl = new URL('/api/v1/auth/check', config.AUTH_MANAGER_URL);
      const response = await fetch(authUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          experiment_id: experimentId,
          required_role: requiredRole,
        }),
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 403) {
          const errorBody = await response.json();
          return c.json(errorBody, response.status);
        }
        throw new Error(`Auth service returned status: ${response.status}`);
      }

      const { authorized } = (await response.json()) as { authorized: boolean };

      if (!authorized) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      await next();
    } catch (error) {
      errorLog('Authorization check failed:', error);
      return c.json(
        { error: 'Service Unavailable: Failed to communicate with authorization service.' },
        503,
      );
    }
  });
};

// ### <<< 修正点 >>> ###
// 新しいミドルウェアを追加
/**
 * ユーザーが認証済みであるか（X-User-Idヘッダーが存在するか）のみを検証するシンプルなミドルウェア
 */
export const requireUser = () => {
  return createMiddleware(async (c, next) => {
    const userId = c.req.header('X-User-Id');
    if (!userId) {
      return c.json({ error: 'Unauthorized: X-User-Id header is required.' }, 401);
    }
    await next();
  });
};
