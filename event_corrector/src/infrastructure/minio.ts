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
export async function ensureMinioBucket(
  maxAttempts = 5,
  baseDelayMs = 1_000,
): Promise<void> {
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt += 1
    try {
      const bucketExists = await minioClient.bucketExists(config.MINIO_RAW_DATA_BUCKET)
      if (!bucketExists) {
        console.warn(`[MinIO] Bucket "${config.MINIO_RAW_DATA_BUCKET}" does not exist. Creating...`)
        await minioClient.makeBucket(config.MINIO_RAW_DATA_BUCKET)
        console.log(`✅ [MinIO] Bucket "${config.MINIO_RAW_DATA_BUCKET}" created successfully.`)
      } else {
        console.log(`✅ [MinIO] Bucket "${config.MINIO_RAW_DATA_BUCKET}" is ready.`)
      }
      return
    } catch (error) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000)
      console.error(
        `❌ [MinIO] Failed to ensure bucket exists (attempt ${attempt}/${maxAttempts}).`,
        error,
      )
      if (attempt >= maxAttempts) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
