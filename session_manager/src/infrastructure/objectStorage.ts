import { Client as S3CompatibleClient } from 'minio';

import { config } from '../config/env';
import {
  describeStorageError,
  waitForObjectStorageConnection,
} from '../../../shared/objectStorage';

export const objectStorageClient = new S3CompatibleClient({
  endPoint: config.OBJECT_STORAGE_ENDPOINT,
  port: config.OBJECT_STORAGE_PORT,
  useSSL: config.OBJECT_STORAGE_USE_SSL,
  accessKey: config.OBJECT_STORAGE_ACCESS_KEY,
  secretKey: config.OBJECT_STORAGE_SECRET_KEY,
});

void (async () => {
  try {
    await waitForObjectStorageConnection(objectStorageClient, {
      onRetry: ({ attempt, maxAttempts, error }) =>
        console.warn(
          `⏳ [ObjectStorage] Waiting for endpoint (attempt ${attempt}/${maxAttempts}). reason=${describeStorageError(error)}`,
        ),
      onSuccess: ({ attempt }) => {
        if (attempt > 1) {
          console.log(`✅ [ObjectStorage] Connected on attempt ${attempt}.`);
        }
      },
      onFailure: ({ error }) =>
        console.error('❌ [ObjectStorage] Failed to connect to object storage.', error),
    });
    const exists = await objectStorageClient.bucketExists(config.OBJECT_STORAGE_MEDIA_BUCKET);
    if (exists) {
      console.log(`✅ [ObjectStorage] Bucket "${config.OBJECT_STORAGE_MEDIA_BUCKET}" is ready.`);
    } else {
      console.warn(
        `⚠️ [ObjectStorage] Bucket "${config.OBJECT_STORAGE_MEDIA_BUCKET}" not found yet. ` +
          'If the object-storage bootstrap is still running, this message can be ignored.',
      );
    }
  } catch (error) {
    console.error('❌ [ObjectStorage] Failed to check for bucket.', error);
  }
})();
