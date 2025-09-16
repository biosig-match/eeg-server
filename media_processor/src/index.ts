import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { Client as MinioClient } from 'minio';
import { Pool } from 'pg';
import path from 'path';

// --- Environment Variables ---
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://admin:password@db:5432/eeg_data';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000', 10);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_MEDIA_BUCKET = process.env.MINIO_MEDIA_BUCKET || 'media';

// --- Constants ---
const MEDIA_PROCESSING_QUEUE = 'media_processing_queue';

// --- Global clients and state ---
let amqpConnection: Connection | null = null;
let amqpChannel: Channel | null = null;
const pgPool = new Pool({ connectionString: DATABASE_URL });
const minioClient = new MinioClient({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

/**
 * Main message processing logic for media files.
 */
async function processMessage(msg: ConsumeMessage | null) {
  if (!msg) return;

  try {
    const fileBuffer = msg.content;
    const headers = msg.properties?.headers;

    if (!headers) {
      console.warn('Message missing headers. Acknowledging and discarding.');
      amqpChannel?.ack(msg);
      return;
    } // --- Validation ---

    const user_id = headers['user_id'];
    const session_id = headers['session_id'];
    const mimetype = headers['mimetype'];
    const original_filename = headers['original_filename'];
    const timestamp_utc = headers['timestamp_utc']; // for images
    const start_time_utc = headers['start_time_utc']; // for audio
    const end_time_utc = headers['end_time_utc']; // for audio

    if (!user_id || !session_id || !mimetype || !original_filename) {
      console.warn('Message missing required headers. Acknowledging and discarding.', headers);
      amqpChannel?.ack(msg);
      return;
    } // --- Object ID Generation ---

    const timestamp = new Date((timestamp_utc || start_time_utc || Date.now()) as string | number);
    const timestampMs = timestamp.getTime();
    const mediaType = mimetype.toString().startsWith('image') ? 'photo' : 'audio';
    const extension = path.extname(original_filename.toString());
    const objectId = `media/${user_id}/${session_id}/${timestampMs}_${mediaType}${extension}`; // 1. Upload media file to MinIO

    const metaData = {
      'Content-Type': mimetype.toString(),
      'X-User-Id': user_id.toString(),
      'X-Session-Id': session_id.toString(),
      'X-Original-Filename': original_filename.toString(),
    };
    await minioClient.putObject(
      MINIO_MEDIA_BUCKET,
      objectId,
      fileBuffer,
      fileBuffer.length,
      metaData,
    );
    console.log(`[MinIO] Successfully uploaded: ${objectId}`); // 2. Insert metadata into PostgreSQL based on mimetype

    if (mediaType === 'photo') {
      if (!timestamp_utc) {
        throw new Error('Image message is missing `timestamp_utc` header.');
      }
      const query = `
        INSERT INTO images (object_id, user_id, session_id, timestamp_utc)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (object_id) DO NOTHING;
      `;
      await pgPool.query(query, [objectId, user_id, session_id, timestamp_utc]);
    } else if (mediaType === 'audio') {
      if (!start_time_utc || !end_time_utc) {
        throw new Error('Audio message is missing `start_time_utc` or `end_time_utc` header.');
      }
      const query = `
        INSERT INTO audio_clips (object_id, user_id, session_id, start_time, end_time)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (object_id) DO NOTHING;
      `;
      await pgPool.query(query, [objectId, user_id, session_id, start_time_utc, end_time_utc]);
    } else {
      console.warn(`Unsupported mimetype: ${mimetype}. Discarding message.`);
    }

    console.log(`[PostgreSQL] Successfully inserted metadata for: ${objectId}`); // 3. Acknowledge the message

    amqpChannel?.ack(msg);
  } catch (error: any) {
    console.error('❌ Error processing media message:', error.message);
    amqpChannel?.nack(msg, false, true); // Re-queue for another attempt
  }
}

/**
 * Connects to RabbitMQ, sets up topology, and starts consuming messages.
 */
async function startConsumer() {
  console.log('[RabbitMQ] Connecting...');
  amqpConnection = await amqp.connect(RABBITMQ_URL);
  amqpChannel = await amqpConnection.createChannel();
  console.log('✅ [RabbitMQ] Connected and channel created.');

  await amqpChannel.assertQueue(MEDIA_PROCESSING_QUEUE, { durable: true });
  amqpChannel.prefetch(5); // Process up to 5 media files concurrently

  console.log(
    `🚀 Media Processor service is waiting for messages in queue: "${MEDIA_PROCESSING_QUEUE}"`,
  );
  amqpChannel.consume(MEDIA_PROCESSING_QUEUE, processMessage);
}

/**
 * Ensures the required MinIO bucket exists.
 */
async function ensureMinioBucket() {
  const bucketExists = await minioClient.bucketExists(MINIO_MEDIA_BUCKET);
  if (!bucketExists) {
    console.log(`[MinIO] Bucket "${MINIO_MEDIA_BUCKET}" does not exist. Creating...`);
    await minioClient.makeBucket(MINIO_MEDIA_BUCKET);
    console.log(`✅ [MinIO] Bucket "${MINIO_MEDIA_BUCKET}" created.`);
  } else {
    console.log(`✅ [MinIO] Bucket "${MINIO_MEDIA_BUCKET}" already exists.`);
  }
}

async function main() {
  try {
    await ensureMinioBucket();
    await startConsumer();
  } catch (error) {
    console.error('❌ Failed to start the media processor service:', error);
    process.exit(1);
  }
}

main();
