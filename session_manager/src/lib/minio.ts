import { Client as MinioClient } from 'minio';
import { config } from './config';

export const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

minioClient
  .bucketExists(config.MINIO_MEDIA_BUCKET)
  .then((exists) => {
    if (exists) {
      console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" is ready.`);
    } else {
      console.error(
        `❌ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" does not exist. Please create it.`,
      );
    }
  })
  .catch((err) => {
    console.error('❌ [MinIO] Failed to check for bucket.', err);
  });
