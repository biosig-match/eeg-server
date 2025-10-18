import { RABBITMQ_MANAGEMENT_URL, config } from '../../config/env'
import { fetchWithTimeout } from '../utils/http'

export interface QueueMetrics {
  name: string
  messages: number
  messagesReady: number
  messagesUnacknowledged: number
  consumers: number
  publishRate?: number
  deliverRate?: number
  ackRate?: number
  idleSince?: string | null
}

export interface RabbitStatus {
  healthy: boolean
  checkedAt: string
  queues: Record<string, QueueMetrics>
  error?: string
}

export async function readRabbitStatus(): Promise<RabbitStatus> {
  const checkedAt = new Date().toISOString()
  try {
    console.info(
      `[observability] -> RabbitMQ GET /api/queues/%2F (timeout ${config.SERVICE_TIMEOUT_MS}ms)`,
    )
    const response = await fetchWithTimeout(`${RABBITMQ_MANAGEMENT_URL}/api/queues/%2F`, config.SERVICE_TIMEOUT_MS, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.RABBITMQ_USER}:${config.RABBITMQ_PASSWORD}`).toString('base64')}`,
      },
    })
    if (!response.ok) {
      console.error(
        `[observability] <- RabbitMQ ${response.status} when fetching queue metrics`,
      )
      return {
        healthy: false,
        checkedAt,
        queues: {},
        error: `RabbitMQ management API returned ${response.status}`,
      }
    }
    const queuePayload = (await response.json()) as Array<Record<string, any>>

    const queues: Record<string, QueueMetrics> = {}
    for (const queue of queuePayload) {
      const stats = queue.message_stats ?? {}
      queues[queue.name] = {
        name: queue.name,
        messages: queue.messages ?? 0,
        messagesReady: queue.messages_ready ?? 0,
        messagesUnacknowledged: queue.messages_unacknowledged ?? 0,
        consumers: queue.consumers ?? 0,
        publishRate: stats.publish_details?.rate,
        deliverRate: stats.deliver_get_details?.rate,
        ackRate: stats.ack_details?.rate,
        idleSince: queue.idle_since ?? null,
      }
    }

    console.info(`[observability] RabbitMQ returned metrics for ${Object.keys(queues).length} queues`)
    return {
      healthy: true,
      checkedAt,
      queues,
    }
  } catch (error) {
    console.error(
      `[observability] RabbitMQ management request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return {
      healthy: false,
      checkedAt,
      queues: {},
      error: error instanceof Error ? error.message : 'Unknown error communicating with RabbitMQ management API',
    }
  }
}
