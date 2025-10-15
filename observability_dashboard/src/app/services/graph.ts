import { config } from '../../config/env'
import { checkDatabaseHealth } from './database'
import { readRabbitStatus } from './rabbitmq'
import { checkMinioHealth } from './storage'
import { EdgeDefinition, NodeKind, QueueDefinition, ServiceDefinition, graphEdges, queues, services } from './serviceRegistry'
import { fetchJsonWithTimeout } from '../utils/http'

export type StatusLevel = 'ok' | 'degraded' | 'error' | 'unknown'

export interface NodeStatus {
  level: StatusLevel
  detail?: string
  checkedAt?: string
  latencyMs?: number
}

export interface GraphNode {
  id: string
  label: string
  kind: NodeKind
  description: string
  status: NodeStatus
  attributes?: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  description: string
  kind: EdgeDefinition['kind']
  metrics?: Record<string, unknown>
}

export interface GraphSnapshot {
  generatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  rabbit: {
    healthy: boolean
    error?: string
    checkedAt: string
  }
  postgres: {
    healthy: boolean
    error?: string
    checkedAt: string
    version?: string
  }
  minio: {
    healthy: boolean
    error?: string
    checkedAt: string
    buckets: Array<{ name: string; createdAt?: string }>
  }
}

interface ServiceHealthResult {
  id: string
  status: NodeStatus
}

async function checkServiceHealth(definition: ServiceDefinition): Promise<ServiceHealthResult> {
  if (!definition.healthUrl) {
    return {
      id: definition.id,
      status: { level: 'unknown' },
    }
  }
  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()
  const startedAt = now()
  const result = await fetchJsonWithTimeout<{ status?: string }>(definition.healthUrl, config.SERVICE_TIMEOUT_MS)
  const latencyMs = Math.round(now() - startedAt)
  if (!result.ok) {
    console.error(
      `[observability] Health check failed for ${definition.id}: ${result.error ?? 'unknown error'} (status=${result.status})`,
    )
    return {
      id: definition.id,
      status: {
        level: result.status === 0 ? 'error' : 'degraded',
        detail: result.error,
        latencyMs,
      },
    }
  }
  const bodyStatus = result.data?.status ?? 'unknown'
  const level: StatusLevel = bodyStatus === 'ok' ? 'ok' : bodyStatus === 'degraded' ? 'degraded' : 'ok'
  if (level !== 'ok') {
    console.warn(`[observability] Service ${definition.id} reported status=${bodyStatus}`)
  }
  return {
    id: definition.id,
    status: {
      level,
      detail: bodyStatus,
      checkedAt: new Date().toISOString(),
      latencyMs,
    },
  }
}

function determineQueueStatus(queue: QueueDefinition, rabbitQueues: ReturnType<typeof readRabbitStatus> extends Promise<infer R>
  ? R extends { queues: infer Q }
    ? Q
    : never
  : never): NodeStatus {
  const metrics = rabbitQueues[queue.queueName]
  if (!metrics) {
    console.warn(`[observability] RabbitMQ metrics missing for queue ${queue.queueName}`)
    return { level: 'unknown', detail: 'No metrics available' }
  }
  if (metrics.consumers === 0) {
    console.warn(`[observability] Queue ${queue.queueName} has no active consumers`)
    return { level: 'degraded', detail: 'No active consumers', checkedAt: new Date().toISOString() }
  }
  if (metrics.messagesUnacknowledged > 0 || metrics.messagesReady > 1000) {
    console.warn(
      `[observability] Queue ${queue.queueName} backlog detected: ready=${metrics.messagesReady} unacked=${metrics.messagesUnacknowledged}`,
    )
    return {
      level: 'degraded',
      detail: `Backlog: ${metrics.messagesReady} ready / ${metrics.messagesUnacknowledged} unacked`,
      checkedAt: new Date().toISOString(),
    }
  }
  return { level: 'ok', checkedAt: new Date().toISOString() }
}

export async function buildGraphSnapshot(): Promise<GraphSnapshot> {
  const generatedAt = new Date().toISOString()
  const [serviceHealthResults, rabbitStatus, dbHealth, minioHealth] = await Promise.all([
    Promise.all(services.map((definition) => checkServiceHealth(definition))),
    readRabbitStatus(),
    checkDatabaseHealth(),
    checkMinioHealth(10),
  ])

  const serviceStatusMap = new Map(serviceHealthResults.map((item) => [item.id, item.status]))
  if (!rabbitStatus.healthy) {
    console.error(`[observability] RabbitMQ management API unreachable: ${rabbitStatus.error ?? 'unknown error'}`)
  }
  if (!dbHealth.healthy) {
    console.error(`[observability] Database health check failed: ${dbHealth.error ?? 'unknown error'}`)
  }
  if (!minioHealth.healthy) {
    console.error(`[observability] MinIO health check failed: ${minioHealth.error ?? 'unknown error'}`)
  }
  const nodes: GraphNode[] = []

  for (const service of services) {
    const status =
      service.id === 'rabbitmq'
        ? rabbitStatus.healthy
          ? { level: 'ok', checkedAt: rabbitStatus.checkedAt }
          : { level: 'error', detail: rabbitStatus.error, checkedAt: rabbitStatus.checkedAt }
        : service.id === 'postgres'
          ? dbHealth.healthy
            ? { level: 'ok', checkedAt: dbHealth.checkedAt, detail: dbHealth.version }
            : { level: 'error', detail: dbHealth.error, checkedAt: dbHealth.checkedAt }
          : service.id === 'minio'
            ? minioHealth.healthy
              ? { level: 'ok', checkedAt: minioHealth.checkedAt }
              : { level: 'error', detail: minioHealth.error, checkedAt: minioHealth.checkedAt }
            : serviceStatusMap.get(service.id) ?? { level: 'unknown' }

    nodes.push({
      id: service.id,
      label: service.displayName,
      kind: service.kind,
      description: service.description,
      status,
      attributes:
        service.id === 'minio'
          ? { bucketCount: minioHealth.buckets.length }
          : service.id === 'postgres'
            ? { version: dbHealth.version }
            : undefined,
    })
  }

  for (const queue of queues) {
    const status = determineQueueStatus(queue, rabbitStatus.queues)
    const metrics = rabbitStatus.queues[queue.queueName]
    nodes.push({
      id: queue.id,
      label: queue.displayName,
      kind: 'queue',
      description: queue.description,
      status,
      attributes: metrics
        ? {
            messages: metrics.messages,
            messagesReady: metrics.messagesReady,
            messagesUnacknowledged: metrics.messagesUnacknowledged,
            consumers: metrics.consumers,
            publishRate: metrics.publishRate,
            deliverRate: metrics.deliverRate,
          }
        : undefined,
    })
  }

  const edges: GraphEdge[] = graphEdges.map((edge) => {
    const queueMetrics = edge.queueName ? rabbitStatus.queues[edge.queueName] : undefined
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      description: edge.description,
      kind: edge.kind,
      metrics: queueMetrics
        ? {
            messages: queueMetrics.messages,
            messagesReady: queueMetrics.messagesReady,
            messagesUnacknowledged: queueMetrics.messagesUnacknowledged,
            consumers: queueMetrics.consumers,
            publishRate: queueMetrics.publishRate,
            deliverRate: queueMetrics.deliverRate,
            idleSince: queueMetrics.idleSince,
          }
        : undefined,
    }
  })

  return {
    generatedAt,
    nodes,
    edges,
    rabbit: {
      healthy: rabbitStatus.healthy,
      error: rabbitStatus.error,
      checkedAt: rabbitStatus.checkedAt,
    },
    postgres: {
      healthy: dbHealth.healthy,
      error: dbHealth.error,
      checkedAt: dbHealth.checkedAt,
      version: dbHealth.version,
    },
    minio: {
      healthy: minioHealth.healthy,
      error: minioHealth.error,
      checkedAt: minioHealth.checkedAt,
      buckets: minioHealth.buckets.map((bucket) => ({
        name: bucket.name,
        createdAt: bucket.createdAt,
      })),
    },
  }
}
