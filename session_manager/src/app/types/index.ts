/**
 * RabbitMQ経由でDataLinkerサービスに渡す非同期ジョブのペイロード形式
 */
export interface DataLinkerJobPayload {
  session_id: string;
}
