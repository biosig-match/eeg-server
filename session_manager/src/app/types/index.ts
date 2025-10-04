/**
 * RabbitMQ経由でDataLinkerサービスに渡す非同期ジョブのペイロード形式
 */
export interface DataLinkerJobPayload {
  session_id: string;
  user_id: string;
  experiment_id: string;
  session_start_utc: string; // ISO 8601 format
  session_end_utc: string;
  clock_offset_info?: {
    offset_ms_avg: number;
    rtt_ms_avg: number;
  };
}
