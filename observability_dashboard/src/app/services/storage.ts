import { Client as MinioClient } from 'minio'

import { config } from '../../config/env'

export interface MinioObjectPreview {
  name: string
  size: number
  lastModified: string | null
  etag?: string
}

export interface BucketPreview {
  name: string
  createdAt?: string
  objectSample: MinioObjectPreview[]
}

export interface MinioHealth {
  healthy: boolean
  checkedAt: string
  buckets: BucketPreview[]
  error?: string
}

export const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
  useSSL: config.MINIO_USE_SSL,
})

export async function checkMinioHealth(maxObjectsPerBucket = 20): Promise<MinioHealth> {
  const checkedAt = new Date().toISOString()
  try {
    console.info('[observability] Listing MinIO buckets')
    const buckets = await minioClient.listBuckets()
    const previews: BucketPreview[] = []
    for (const bucket of buckets) {
      console.info(`[observability] Sampling up to ${maxObjectsPerBucket} objects from bucket ${bucket.name}`)
      const objectSample = await listObjectsPreviewWithRetry(bucket.name, maxObjectsPerBucket)
      previews.push({
        name: bucket.name,
        createdAt: bucket.creationDate?.toISOString(),
        objectSample,
      })
    }
    console.info(`[observability] MinIO responded with ${previews.length} buckets`)
    return {
      healthy: true,
      checkedAt,
      buckets: previews,
    }
  } catch (error) {
    console.error(
      `[observability] MinIO health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return {
      healthy: false,
      checkedAt,
      buckets: [],
      error: error instanceof Error ? error.message : 'Unknown MinIO error',
    }
  }
}

export async function listObjectsPreview(bucketName: string, limit: number): Promise<MinioObjectPreview[]> {
  return new Promise((resolve, reject) => {
    const results: MinioObjectPreview[] = []
    const stream = minioClient.listObjectsV2(bucketName, '', false)

    const TIMEOUT_MS = 5000
    let settled = false
    let timeoutId: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      stream.removeAllListeners()
      if (!stream.destroyed) {
        stream.destroy()
      }
    }

    const finalize = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(results)
    }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    timeoutId = setTimeout(() => {
      fail(new Error(`Timeout while listing objects in bucket ${bucketName}`))
    }, TIMEOUT_MS)

    stream.on('data', (obj) => {
      if (settled) {
        return
      }
      if (results.length >= limit) {
        finalize()
        return
      }
      results.push({
        name: obj.name ?? '',
        size: obj.size ?? 0,
        lastModified: obj.lastModified ? obj.lastModified.toISOString() : null,
        etag: obj.etag,
      })
    })
    stream.on('end', finalize)
    stream.on('close', finalize)
    stream.on('error', (err) => {
      console.error(`[observability] MinIO listObjectsV2 error for bucket ${bucketName}:`, err)
      fail(err)
    })
  })
}

async function listObjectsPreviewWithRetry(bucketName: string, limit: number, maxRetries = 3): Promise<MinioObjectPreview[]> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await listObjectsPreview(bucketName, limit)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(
        `[observability] Failed to list objects for bucket ${bucketName} (attempt ${attempt}/${maxRetries}): ${lastError.message}`,
      )
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100))
      }
    }
  }

  throw lastError ?? new Error(`Unable to list objects for bucket ${bucketName}`)
}
