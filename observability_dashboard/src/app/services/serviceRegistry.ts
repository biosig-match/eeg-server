import { config } from '../../config/env'

export type NodeKind = 'gateway' | 'service' | 'broker' | 'database' | 'storage' | 'queue'

export interface ServiceDefinition {
  id: string
  displayName: string
  kind: NodeKind
  description: string
  healthUrl?: string
}

export interface QueueDefinition {
  id: string
  queueName: string
  displayName: string
  description: string
}

export type EdgeKind = 'http' | 'queue' | 'storage' | 'database'

export interface EdgeDefinition {
  id: string
  from: string
  to: string
  description: string
  kind: EdgeKind
  queueName?: string
}

export const queueId = (queueName: string) => `queue:${queueName}`

const processingQueueId = queueId(config.PROCESSING_QUEUE)
const mediaQueueId = queueId(config.MEDIA_PROCESSING_QUEUE)
const dataLinkerQueueId = queueId(config.DATA_LINKER_QUEUE)
const eventCorrectionQueueId = queueId(config.EVENT_CORRECTION_QUEUE)
const stimulusAssetQueueId = queueId(config.STIMULUS_ASSET_QUEUE)

export const services: ServiceDefinition[] = [
  {
    id: 'ingress',
    displayName: 'Ingress (Nginx)',
    kind: 'gateway',
    description: 'クライアントからのリクエストを内部サービスへ振り分ける外向きの入口です。',
  },
  {
    id: 'collector',
    displayName: 'Collector',
    kind: 'service',
    description: '生のEEGおよびバイオメトリックデータを受信し、RabbitMQへ配信します。',
    healthUrl: 'http://collector:3000/health',
  },
  {
    id: 'processor',
    displayName: 'Processor',
    kind: 'service',
    description: 'センサーバッチを伸長してTimescaleDBへ保存し、MinIOにオブジェクトを書き込みます。',
    healthUrl: 'http://processor:3010/health',
  },
  {
    id: 'media_processor',
    displayName: 'Media Processor',
    kind: 'service',
    description: 'メディアアップロードを取り込み、メタデータを正規化してMinIOへ保存します。',
    healthUrl: 'http://media_processor:3020/health',
  },
  {
    id: 'session_manager',
    displayName: 'Session Manager',
    kind: 'service',
    description: '実験やセッションを作成し、RabbitMQ経由で後段のリンクジョブを配信します。',
    healthUrl: 'http://session_manager:3000/health',
  },
  {
    id: 'data_linker',
    displayName: 'Data Linker',
    kind: 'service',
    description: '生データオブジェクトをセッションに紐付け、イベント補正ジョブを起動します。',
    healthUrl: 'http://data_linker:3030/health',
  },
  {
    id: 'event_corrector',
    displayName: 'Event Corrector',
    kind: 'service',
    description: 'MinIOから生データを取得し、イベントのタイムラインを補正して結果を保存します。',
    healthUrl: 'http://event_corrector:3040/health',
  },
  {
    id: 'stimulus_asset_processor',
    displayName: 'Stimulus Asset Processor',
    kind: 'service',
    description: '刺激アセットを処理し、生成した成果物をMinIOへアップロードします。',
    healthUrl: 'http://stimulus_asset_processor:3050/health',
  },
  {
    id: 'bids_exporter',
    displayName: 'BIDS Exporter',
    kind: 'service',
    description: 'BIDS準拠のアーカイブを生成し、非同期エクスポートタスクを管理します。',
    healthUrl: 'http://bids_exporter:8000/health',
  },
  {
    id: 'realtime_analyzer',
    displayName: 'Realtime Analyzer',
    kind: 'service',
    description: '処理済みセンサーデータからリアルタイムEEG解析を提供します。',
    healthUrl: 'http://realtime_analyzer:5002/health',
  },
  {
    id: 'auth_manager',
    displayName: 'Auth Manager',
    kind: 'service',
    description: 'PostgreSQLを基盤に認証・認可データを取り扱います。',
    healthUrl: 'http://auth_manager:3000/health',
  },
  {
    id: 'erp_neuro_marketing',
    displayName: 'ERP Neuro Marketing',
    kind: 'service',
    description: 'BIDSエクスポートを利用してERP特化の分析を実行します。',
    healthUrl: 'http://erp_neuro_marketing:8001/health',
  },
  {
    id: 'rabbitmq',
    displayName: 'RabbitMQ',
    kind: 'broker',
    description: '非同期ワークロードを仲介するメッセージブローカーです。',
  },
  {
    id: 'postgres',
    displayName: 'PostgreSQL (TimescaleDB)',
    kind: 'database',
    description: '実験・セッション・イベント・タスクメタデータを保持する主要なリレーショナルストアです。',
  },
  {
    id: 'minio',
    displayName: 'MinIO',
    kind: 'storage',
    description: '生ストリームやメディア、BIDSエクスポートを保管するS3互換オブジェクトストレージです。',
  },
]

export const queues: QueueDefinition[] = [
  {
    id: processingQueueId,
    queueName: config.PROCESSING_QUEUE,
    displayName: 'Processing Queue',
    description: '処理ワーカーを待つセンサーデータバッチです。',
  },
  {
    id: mediaQueueId,
    queueName: config.MEDIA_PROCESSING_QUEUE,
    displayName: 'Media Processing Queue',
    description: '正規化と永続化を待つアップロード済みメディアです。',
  },
  {
    id: dataLinkerQueueId,
    queueName: config.DATA_LINKER_QUEUE,
    displayName: 'Data Linker Queue',
    description: '収集済み生データとセッションを結び付けるジョブです。',
  },
  {
    id: eventCorrectionQueueId,
    queueName: config.EVENT_CORRECTION_QUEUE,
    displayName: 'Event Correction Queue',
    description: '生信号のタイムスタンプに基づきセッションイベントを調整するタスクです。',
  },
  {
    id: stimulusAssetQueueId,
    queueName: config.STIMULUS_ASSET_QUEUE,
    displayName: 'Stimulus Asset Queue',
    description: '実験更新で起動される刺激アセット処理ジョブです。',
  },
]

export const graphEdges: EdgeDefinition[] = [
  {
    id: 'ingress-to-collector',
    from: 'ingress',
    to: 'collector',
    description: 'HTTP入力をNginx経由でCollector APIへルーティングします。',
    kind: 'http',
  },
  {
    id: 'ingress-to-session-manager',
    from: 'ingress',
    to: 'session_manager',
    description: '外部クライアント向けの実験管理APIをIngressからSession Managerへプロキシします。',
    kind: 'http',
  },
  {
    id: 'ingress-to-data-linker',
    from: 'ingress',
    to: 'data_linker',
    description: 'データリンカのジョブ制御エンドポイントをIngressが公開します。',
    kind: 'http',
  },
  {
    id: 'ingress-to-event-corrector',
    from: 'ingress',
    to: 'event_corrector',
    description: 'イベント補正ジョブの管理APIをIngress経由で提供します。',
    kind: 'http',
  },
  {
    id: 'ingress-to-processor',
    from: 'ingress',
    to: 'processor',
    description: 'バッチ処理ステータスAPIをIngressがProcessorへフォワードします。',
    kind: 'http',
  },
  {
    id: 'ingress-to-media-processor',
    from: 'ingress',
    to: 'media_processor',
    description: 'メディア処理ジョブのWebhook・APIをIngressが中継します。',
    kind: 'http',
  },
  {
    id: 'ingress-to-stimulus-asset-processor',
    from: 'ingress',
    to: 'stimulus_asset_processor',
    description: '刺激アセット処理APIをIngressからStimulus Asset Processorへルーティングします。',
    kind: 'http',
  },
  {
    id: 'ingress-to-bids-exporter',
    from: 'ingress',
    to: 'bids_exporter',
    description: 'BIDSエクスポート管理APIをIngressが外部に公開します。',
    kind: 'http',
  },
  {
    id: 'ingress-to-realtime-analyzer',
    from: 'ingress',
    to: 'realtime_analyzer',
    description: 'リアルタイム解析のWebSocket/HTTPエンドポイントをIngressが中継します。',
    kind: 'http',
  },
  {
    id: 'ingress-to-auth-manager',
    from: 'ingress',
    to: 'auth_manager',
    description: '認証・認可APIをIngress経由で外部クライアントへ提供します。',
    kind: 'http',
  },
  {
    id: 'collector-to-rabbitmq',
    from: 'collector',
    to: 'rabbitmq',
    description: 'Collectorが生データをfanout exchange（raw_data_exchange）にPublishします。',
    kind: 'queue',
  },
  {
    id: 'processing-queue-to-processor',
    from: processingQueueId,
    to: 'processor',
    description: 'Processorのワーカーがセンサーバッチを取り込み復号します。',
    kind: 'queue',
    queueName: config.PROCESSING_QUEUE,
  },
  {
    id: 'rabbitmq-to-realtime-analyzer',
    from: 'rabbitmq',
    to: 'realtime_analyzer',
    description: 'Realtime AnalyzerがRabbitMQのfanout交換からストリームを購読します。',
    kind: 'queue',
  },
  {
    id: 'collector-to-media-queue',
    from: 'collector',
    to: mediaQueueId,
    description: 'メディアアップロードを専用の処理キューへ転送します。',
    kind: 'queue',
    queueName: config.MEDIA_PROCESSING_QUEUE,
  },
  {
    id: 'media-queue-to-media-processor',
    from: mediaQueueId,
    to: 'media_processor',
    description: 'Media Processorがアップロードを処理し、成果物を保存します。',
    kind: 'queue',
    queueName: config.MEDIA_PROCESSING_QUEUE,
  },
  {
    id: 'processor-to-postgres',
    from: 'processor',
    to: 'postgres',
    description: '正規化した信号とメタデータをTimescaleDBへ保存します。',
    kind: 'database',
  },
  {
    id: 'processor-to-minio',
    from: 'processor',
    to: 'minio',
    description: `デコードしたペイロード断片をMinIOバケット ${config.MINIO_RAW_DATA_BUCKET} にアップロードします。`,
    kind: 'storage',
  },
  {
    id: 'session-manager-to-data-linker-queue',
    from: 'session_manager',
    to: dataLinkerQueueId,
    description: 'セッション終了でData Linkerのジョブを起動します。',
    kind: 'queue',
    queueName: config.DATA_LINKER_QUEUE,
  },
  {
    id: 'data-linker-queue-to-data-linker',
    from: dataLinkerQueueId,
    to: 'data_linker',
    description: 'Data Linkerサービスがジョブを処理し、セッションと生データを結び付けます。',
    kind: 'queue',
    queueName: config.DATA_LINKER_QUEUE,
  },
  {
    id: 'data-linker-to-postgres',
    from: 'data_linker',
    to: 'postgres',
    description: 'リンク済みセッションのメタデータをPostgreSQLへ保存します。',
    kind: 'database',
  },
  {
    id: 'data-linker-to-event-correction-queue',
    from: 'data_linker',
    to: eventCorrectionQueueId,
    description: 'リンク完了後にイベント補正ジョブをキューに追加します。',
    kind: 'queue',
    queueName: config.EVENT_CORRECTION_QUEUE,
  },
  {
    id: 'event-correction-queue-to-event-corrector',
    from: eventCorrectionQueueId,
    to: 'event_corrector',
    description: 'Event Correctorがジョブを処理し、タイムラインのオフセットを調整します。',
    kind: 'queue',
    queueName: config.EVENT_CORRECTION_QUEUE,
  },
  {
    id: 'event-corrector-to-postgres',
    from: 'event_corrector',
    to: 'postgres',
    description: '補正済みイベントマーカーをPostgreSQLへ書き戻します。',
    kind: 'database',
  },
  {
    id: 'event-corrector-to-minio',
    from: 'event_corrector',
    to: 'minio',
    description: `整列済みの生データ断片をMinIOバケット ${config.MINIO_RAW_DATA_BUCKET} に保存します。`,
    kind: 'storage',
  },
  {
    id: 'session-manager-to-stimulus-queue',
    from: 'session_manager',
    to: stimulusAssetQueueId,
    description: '実験の更新で刺激アセット処理をキューに登録します。',
    kind: 'queue',
    queueName: config.STIMULUS_ASSET_QUEUE,
  },
  {
    id: 'stimulus-queue-to-stimulus-processor',
    from: stimulusAssetQueueId,
    to: 'stimulus_asset_processor',
    description: 'Stimulus Asset Processorがキュー内のアセットジョブを処理します。',
    kind: 'queue',
    queueName: config.STIMULUS_ASSET_QUEUE,
  },
  {
    id: 'stimulus-processor-to-minio',
    from: 'stimulus_asset_processor',
    to: 'minio',
    description: `処理済み刺激アセットをMinIOバケット ${config.MINIO_MEDIA_BUCKET} にアップロードします。`,
    kind: 'storage',
  },
  {
    id: 'media-processor-to-minio',
    from: 'media_processor',
    to: 'minio',
    description: `正規化したメディアクリップをMinIOバケット ${config.MINIO_MEDIA_BUCKET} に保存します。`,
    kind: 'storage',
  },
  {
    id: 'media-processor-to-postgres',
    from: 'media_processor',
    to: 'postgres',
    description: 'メディアのメタデータをPostgreSQLへ保存します。',
    kind: 'database',
  },
  {
    id: 'session-manager-to-bids-exporter',
    from: 'session_manager',
    to: 'bids_exporter',
    description: 'Session ManagerがHTTP経由でBIDSエクスポートタスクを起動します。',
    kind: 'http',
  },
  {
    id: 'bids-exporter-to-postgres',
    from: 'bids_exporter',
    to: 'postgres',
    description: 'BIDS ExporterがPostgreSQLから実験メタデータとタスク状態を読み取ります。',
    kind: 'database',
  },
  {
    id: 'bids-exporter-to-minio',
    from: 'bids_exporter',
    to: 'minio',
    description: `生成したBIDSアーカイブをMinIOバケット ${config.MINIO_BIDS_EXPORTS_BUCKET} に保存します。`,
    kind: 'storage',
  },
  {
    id: 'bids-exporter-to-erp',
    from: 'bids_exporter',
    to: 'erp_neuro_marketing',
    description: 'ERP分析サービスが共有ボリュームおよびAPIから生成済みデータセットを取得します。',
    kind: 'http',
  },
  {
    id: 'rabbitmq-hosts-processing-queue',
    from: 'rabbitmq',
    to: processingQueueId,
    description: 'Processing QueueはRabbitMQのファンアウト交換上に存在します。',
    kind: 'queue',
  },
  {
    id: 'rabbitmq-hosts-media-queue',
    from: 'rabbitmq',
    to: mediaQueueId,
    description: 'Media Processing QueueはRabbitMQ上に定義された専用のワークキューです。',
    kind: 'queue',
  },
  {
    id: 'rabbitmq-hosts-data-linker-queue',
    from: 'rabbitmq',
    to: dataLinkerQueueId,
    description: 'Data Linker QueueはRabbitMQで管理されるジョブキューです。',
    kind: 'queue',
  },
  {
    id: 'rabbitmq-hosts-event-correction-queue',
    from: 'rabbitmq',
    to: eventCorrectionQueueId,
    description: 'Event Correction QueueはRabbitMQでイベント補正タスクを仲介します。',
    kind: 'queue',
  },
  {
    id: 'rabbitmq-hosts-stimulus-queue',
    from: 'rabbitmq',
    to: stimulusAssetQueueId,
    description: 'Stimulus Asset QueueはRabbitMQで管理される刺激アセット処理用キューです。',
    kind: 'queue',
  },
  {
    id: 'realtime-analyzer-to-rabbitmq',
    from: 'rabbitmq',
    to: 'realtime_analyzer',
    description: 'Realtime Analyzerがストリーミング解析チャネルを購読します。',
    kind: 'queue',
  },
  {
    id: 'auth-manager-to-postgres',
    from: 'auth_manager',
    to: 'postgres',
    description: 'Authサービスが認証情報とセッションデータをPostgreSQLで管理します。',
    kind: 'database',
  },
  {
    id: 'erp-to-postgres',
    from: 'erp_neuro_marketing',
    to: 'postgres',
    description: 'ERP分析の結果を後続処理向けに保存します。',
    kind: 'database',
  },
]
