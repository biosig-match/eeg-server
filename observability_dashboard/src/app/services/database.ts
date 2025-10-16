import { Pool } from 'pg'
import format from 'pg-format'

import { DATABASE_URL } from '../../config/env'

export const pgPool = new Pool({
  connectionString: DATABASE_URL,
})

export interface DatabaseHealth {
  healthy: boolean
  checkedAt: string
  version?: string
  error?: string
}

export interface TableSummary {
  schema: string
  name: string
  rowEstimate: number
  totalBytes: number
  tableBytes: number
  indexBytes: number
  toastBytes: number
  lastAnalyzed: string | null
}

export interface ColumnDescription {
  columnName: string
  dataType: string
  isNullable: boolean
}

export interface TableSample {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export interface ExportTaskRow {
  taskId: string
  experimentId: string
  status: string
  progress: number
  resultFilePath: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const checkedAt = new Date().toISOString()
  try {
    const versionResult = await pgPool.query<{ version: string }>('SHOW server_version')
    const version = versionResult.rows[0]?.version
    console.info(`[observability] PostgreSQL health OK (version=${version ?? 'unknown'})`)
    return {
      healthy: true,
      checkedAt,
      version,
    }
  } catch (error) {
    console.error(
      `[observability] PostgreSQL health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    return {
      healthy: false,
      checkedAt,
      error: error instanceof Error ? error.message : 'Unknown database error',
    }
  }
}

export async function listUserTables(): Promise<TableSummary[]> {
  console.info('[observability] Querying pg_stat_user_tables for size statistics')
  const query = `
    SELECT
      schemaname,
      relname,
      COALESCE(n_live_tup, 0) AS row_estimate,
      pg_total_relation_size(relid) AS total_bytes,
      pg_relation_size(relid) AS table_bytes,
      pg_indexes_size(relid) AS index_bytes,
      GREATEST(pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid), 0) AS toast_bytes,
      to_char(last_analyze, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_analyzed
    FROM pg_catalog.pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC;
  `
  try {
    const result = await pgPool.query(query)
    console.info(`[observability] Retrieved statistics for ${result.rowCount} tables`)
    return result.rows.map((row) => ({
      schema: row.schemaname,
      name: row.relname,
      rowEstimate: Number(row.row_estimate),
      totalBytes: Number(row.total_bytes),
      tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
      toastBytes: Number(row.toast_bytes),
      lastAnalyzed: row.last_analyzed,
    }))
  } catch (error) {
    console.error(
      `[observability] Failed to load table statistics: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    throw error
  }
}

export async function describeTableColumns(schema: string, table: string): Promise<ColumnDescription[]> {
  const result = await pgPool.query(
    `
      SELECT
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position;
    `,
    [schema, table],
  )
  console.info(
    `[observability] Loaded ${result.rowCount} column definitions for ${schema}.${table}`,
  )
  return result.rows.map((row) => ({
    columnName: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable === 'YES',
  }))
}

export async function readTableSample(schema: string, table: string, limit: number): Promise<TableSample> {
  const query = format('SELECT * FROM %I.%I LIMIT %L', schema, table, limit)
  console.info(`[observability] Sampling ${limit} rows from ${schema}.${table}`)
  const result = await pgPool.query(query)
  return {
    columns: result.fields.map((field) => field.name),
    rows: result.rows,
  }
}

export async function listExportTasks(limit: number): Promise<ExportTaskRow[]> {
  console.info(`[observability] Loading up to ${limit} rows from export_tasks`)
  const result = await pgPool.query(
    `
      SELECT
        task_id::text AS task_id,
        experiment_id::text AS experiment_id,
        status,
        progress,
        result_file_path,
        error_message,
        created_at,
        updated_at
      FROM export_tasks
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    [limit],
  )
  console.info(`[observability] Retrieved ${result.rowCount} export task rows`)
  return result.rows.map((row) => ({
    taskId: row.task_id,
    experimentId: row.experiment_id,
    status: row.status,
    progress: Number(row.progress),
    resultFilePath: row.result_file_path,
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }))
}
