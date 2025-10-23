import type { Client as S3CompatibleClient } from 'minio'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const MAX_BACKOFF_MS = 10_000

export interface RetryCallbackContext {
  attempt: number
  maxAttempts: number
  error: unknown
  delayMs: number
}

export interface SuccessCallbackContext {
  attempt: number
}

export interface FailureCallbackContext {
  attempt: number
  maxAttempts: number
  error: unknown
}

export interface WaitForConnectionOptions {
  maxAttempts?: number
  baseDelayMs?: number
  onRetry?: (context: RetryCallbackContext) => void
  onSuccess?: (context: SuccessCallbackContext) => void
  onFailure?: (context: FailureCallbackContext) => void
}

export interface EnsureBucketOptions extends WaitForConnectionOptions {
  onCreateStart?: () => void
  onCreateSuccess?: () => void
  onAlreadyExists?: () => void
}

type ListBucketsClient = Pick<S3CompatibleClient, 'listBuckets'>
type BucketLifecycleClient = Pick<S3CompatibleClient, 'bucketExists' | 'makeBucket'>

export const describeStorageError = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const maybeError = error as { code?: unknown; name?: unknown; message?: unknown }
    if (typeof maybeError.code === 'string' && maybeError.code) return maybeError.code
    if (typeof maybeError.name === 'string' && maybeError.name) return maybeError.name
    if (typeof maybeError.message === 'string' && maybeError.message) return maybeError.message
    try {
      return JSON.stringify(maybeError)
    } catch {
      // noop – fall through to generic string conversion
    }
  }
  return String(error)
}

export async function waitForObjectStorageConnection(
  client: ListBucketsClient,
  {
    maxAttempts = 10,
    baseDelayMs = 1_000,
    onRetry,
    onSuccess,
    onFailure,
  }: WaitForConnectionOptions = {},
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.listBuckets()
      onSuccess?.({ attempt })
      return
    } catch (error) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      onRetry?.({ attempt, maxAttempts, error, delayMs })
      if (attempt === maxAttempts) {
        onFailure?.({ attempt, maxAttempts, error })
        throw error
      }
      await sleep(delayMs)
    }
  }
}

export async function ensureBucketExists(
  client: BucketLifecycleClient,
  bucketName: string,
  {
    maxAttempts = 5,
    baseDelayMs = 1_000,
    onRetry,
    onSuccess,
    onFailure,
    onCreateStart,
    onCreateSuccess,
    onAlreadyExists,
  }: EnsureBucketOptions = {},
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const exists = await client.bucketExists(bucketName)
      if (!exists) {
        onCreateStart?.()
        await client.makeBucket(bucketName)
        onCreateSuccess?.()
      } else {
        onAlreadyExists?.()
      }
      onSuccess?.({ attempt })
      return
    } catch (error) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      onRetry?.({ attempt, maxAttempts, error, delayMs })
      if (attempt === maxAttempts) {
        onFailure?.({ attempt, maxAttempts, error })
        throw error
      }
      await sleep(delayMs)
    }
  }
}
