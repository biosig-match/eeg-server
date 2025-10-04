import { Client as MinioClient } from 'minio'
import { config } from '../config/env'

export const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

/**
 * サービス起動時に、必要なMinIOバケットが存在することを保証します。
 * 存在しない場合は作成を試みます。
 */
export async function ensureMinioBucket(): Promise<void> {
  try {
    const bucketExists = await minioClient.bucketExists(config.MINIO_MEDIA_BUCKET);
    if (!bucketExists) {
      console.warn(`[MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" does not exist. Creating...`);
      await minioClient.makeBucket(config.MINIO_MEDIA_BUCKET);
      console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" created successfully.`);
    } else {
      console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" is ready.`);
    }
  } catch (error) {
    console.error('❌ [MinIO] Failed to ensure bucket exists.', error);
    // 起動時に失敗した場合はサービスを停止させる
    throw error;
  }
}
