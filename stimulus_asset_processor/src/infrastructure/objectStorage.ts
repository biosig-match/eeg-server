import { Client as S3CompatibleClient } from 'minio'

import { config } from '../config/env'
import {
  describeStorageError,
  ensureBucketExists,
  waitForObjectStorageConnection,
} from '../../../shared/objectStorage'

export const objectStorageClient = new S3CompatibleClient({
  endPoint: config.OBJECT_STORAGE_ENDPOINT,
  port: config.OBJECT_STORAGE_PORT,
  useSSL: config.OBJECT_STORAGE_USE_SSL,
  accessKey: config.OBJECT_STORAGE_ACCESS_KEY,
  secretKey: config.OBJECT_STORAGE_SECRET_KEY,
})

/**
 * サービス起動時に、必要なオブジェクトストレージのバケットが存在することを保証します。
 * 存在しない場合は作成を試みます。
 */
export async function ensureObjectStorageBucket(
  maxAttempts = 5,
  baseDelayMs = 1_000,
): Promise<void> {
  const connectionAttempts = Math.max(maxAttempts, 10)

  await waitForObjectStorageConnection(objectStorageClient, {
    maxAttempts: connectionAttempts,
    baseDelayMs,
    onRetry: ({ attempt, maxAttempts: max, error }) =>
      console.warn(
        `⏳ [ObjectStorage] Waiting for endpoint (attempt ${attempt}/${max}). reason=${describeStorageError(error)}`,
      ),
    onSuccess: ({ attempt }) => {
      if (attempt > 1) {
        console.log(`✅ [ObjectStorage] Connected on attempt ${attempt}.`)
      }
    },
    onFailure: ({ error }) =>
      console.error('❌ [ObjectStorage] Failed to connect to object storage.', error),
  })

  await ensureBucketExists(objectStorageClient, config.OBJECT_STORAGE_MEDIA_BUCKET, {
    maxAttempts,
    baseDelayMs,
    onCreateStart: () =>
      console.warn(
        `[ObjectStorage] Bucket "${config.OBJECT_STORAGE_MEDIA_BUCKET}" does not exist. Creating...`,
      ),
    onCreateSuccess: () =>
      console.log(`✅ [ObjectStorage] Bucket "${config.OBJECT_STORAGE_MEDIA_BUCKET}" created successfully.`),
    onAlreadyExists: () =>
      console.log(`✅ [ObjectStorage] Bucket "${config.OBJECT_STORAGE_MEDIA_BUCKET}" is ready.`),
    onRetry: ({ attempt, maxAttempts: max, error }) =>
      console.warn(
        `⏳ [ObjectStorage] Bucket check will retry (attempt ${attempt}/${max}). reason=${describeStorageError(error)}`,
      ),
    onFailure: ({ attempt, maxAttempts: max, error }) =>
      console.error(
        `❌ [ObjectStorage] Failed to ensure bucket exists (attempt ${attempt}/${max}).`,
        error,
      ),
  })
}
