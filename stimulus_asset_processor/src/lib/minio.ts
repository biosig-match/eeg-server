import { Client as MinioClient } from 'minio';
import { config } from './config';

// MinIOへのクライアントインスタンス
export const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

// 起動時にバケットの存在確認
minioClient
  .bucketExists(config.MINIO_MEDIA_BUCKET)
  .then((exists) => {
    if (exists) {
      console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" is ready.`);
    } else {
      console.error(
        `❌ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" does not exist. Please create it.`,
      );
      // バケットが存在しない場合、致命的なエラーとして終了
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('❌ [MinIO] Failed to check for bucket.', err);
    process.exit(1);
  });
