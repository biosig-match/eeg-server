EEG Data Collection & BIDS Export System
1. 概要 (Overview)
本システムは、カスタムESP32脳波計やその他の生体計測デバイスから送られてくる時系列データ（EEG, IMU等）をリアルタイムで収集し、科学研究で標準的なBIDS (Brain Imaging Data Structure)形式でのエクスポートを可能にする、スケーラブルなバックエンドサーバーです。

マイクロサービスアーキテクチャを採用しており、各機能が独立したコンテナとして動作するため、高い可用性とメンテナンス性を実現しています。

主な機能
リアルタイムデータ収集: WebSocketを通じて、低遅延で連続的な生体信号データを受信。

非同期処理パイプライン: RabbitMQメッセージキューを利用し、大量のデータを安定して処理。

時系列データベース: TimescaleDB (PostgreSQL拡張) を採用し、膨大なセンサーデータを効率的に格納・クエリ。

BIDS自動エクスポート: 収集した実験データとイベント情報を紐付け、BIDS規約に準拠した形式で自動出力。

リアルタイム解析: 受信データの一部をリアルタイムで解析（PSD、同期度）し、クライアントアプリでの可視化をサポート。

2. システムアーキテクチャ (System Architecture)
本システムは7つの独立したDockerコンテナで構成され、docker-compose.ymlによって連携して動作します。

サービス一覧
サービス

コンテナ名

役割

Ingress

erp_ingress

APIゲートウェイ (Nginx)。全ての外部リクエストを受け付け、適切なサービスに振り分ける。WebSocket通信のプロキシも担当。

Collector

erp_collector

データ受信API (Node.js)。WebSocket (EEG/IMU) とHTTP (メディア) の両方からデータを受信し、一切の処理をせず即座にRabbitMQへ転送する。

Processor

eeg-server-processor-n

データ処理ワーカー (Python)。RabbitMQから生データを受信し、解凍・パース・タイムスタンプ計算を行い、TimescaleDBに格納する。CPU負荷の高い処理を担う。

BIDS Manager

erp_bids_manager

実験管理・BIDSエクスポートAPI (Python/Flask)。実験の開始/終了、イベントCSVの登録、BIDSエクスポートの非同期実行を管理する。

Realtime Analyzer

erp_realtime_analyzer

リアルタイム解析API (Python/Flask)。処理済みの脳波データを購読し、PSDや同期度を計算してアプリに結果を提供する。

Database

erp_db

時系列データベース (TimescaleDB)。全ての実験メタデータ、脳波・IMUデータ、イベント情報を永続化する。

Message Queue

erp_rabbitmq

メッセージブローカー (RabbitMQ)。サービス間のデータの受け渡しを非同期で行い、システム全体の安定性を担保する。

3. データフロー (Data Flow)
データは以下の流れでシステム内を処理されます。

データ受信:

ESP32から送信された圧縮済み生体信号データは、スマホアプリ経由でCollectorのWebSocketエンドポイント (/api/v1/eeg) に送信される。

Collectorは受信したバイナリデータを、付加情報（デバイスID等）と共にRabbitMQのraw_data_exchangeへeeg.rawというキーでPublishする。

データ処理と格納:

Processorサービス（複数インスタンスが稼働）がprocessing_queueからeeg.rawメッセージを一つずつ取り出す。

受信したデータを解凍し、ヘッダとペイロードに分割。

各サンプルデータに正確なUTCタイムスタンプを計算し、eeg_raw_dataテーブルに格納する。

もし進行中の実験があれば、そのexperiment_idをデータに紐付ける。

処理済みの脳波データを、Realtime Analyzerが購読できるようにprocessed_data_exchangeへeeg.processedというキーでPublishする。

実験管理:

スマホアプリが「実験開始」ボタンを押すと、BIDS Managerの/api/v1/experimentsエンドポイントにリクエストが送られ、experimentsテーブルに新しいレコードが作成される。

実験終了時、アプリはイベントが記述されたCSVファイルをBIDS Managerの/api/v1/experiments/{id}/eventsにアップロードする。

BIDS Managerは、データベースに記録されたトリガ信号のタイムスタンプとCSVの行を照合し、正確なonsetを計算してexperiment_eventsテーブルに保存する。

BIDSエクスポート:

dummy_data_sender.pyや外部クライアントが/api/v1/experiments/{id}/exportを叩くと、BIDS Managerは非同期タスクを開始する。

対象の実験データをDBからすべて取得し、mne-bidsライブラリを使ってBIDS形式のファイル群（.edf, .json, .tsv）を生成。

生成されたファイルは、ホストマシンのbids_outputディレクトリに保存される。

4. APIエンドポイント (API Endpoints)
Ingress (Nginx) は以下のエンドポイントを公開します。

ws://<host>:8080/api/v1/eeg

メソッド: WebSocket

サービス: collector

役割: ESP32からの圧縮済み生体信号データを受信します。

/api/v1/experiments

メソッド: POST

サービス: bids_manager

役割: 新しい実験セッションを開始します。

/api/v1/experiments/{experiment_id}/events

メソッド: POST

サービス: bids_manager

役割: イベントが記述されたCSVファイルをアップロードし、実験を終了します。

/api/v1/experiments/{experiment_id}/export

メソッド: POST

サービス: bids_manager

役割: 指定された実験のBIDSエクスポートタスクを開始します。

/api/v1/export-tasks/{task_id}

メソッド: GET

サービス: bids_manager

役割: BIDSエクスポートタスクの進捗状況を確認します。

/api/v1/analysis/results

メソッド: GET

サービス: realtime_analyzer

役割: 最新のリアルタイム解析結果（PSD/同期度の画像）を取得します。

5. 実行方法 (Getting Started)
前提条件
WSL2 (Ubuntu推奨)

Docker Engine

Docker Compose

手順
リポジトリのクローン:

git clone <repository_url>
cd eeg-server

.envファイルの作成:
プロジェクトのルートディレクトリに.envという名前のファイルを新規作成し、以下の内容を記述します。

# RabbitMQ Settings
RABBITMQ_USER=guest
RABBITMQ_PASSWORD=guest
RABBITMQ_HOST=rabbitmq
RABBITMQ_MGMT_PORT=15672

# PostgreSQL/TimescaleDB Settings
POSTGRES_USER=admin
POSTGRES_PASSWORD=password
POSTGRES_DB=erp_data
POSTGRES_HOST=db

# Nginx Port
NGINX_PORT=8080

コンテナのビルドと起動:
以下のコマンドで、全サービスのDockerイメージをビルドし、バックグラウンドで起動します。

docker compose up --build -d

起動状態の確認:

docker compose ps

全てのサービスのSTATUSがrunningまたはrunning (healthy)になっていれば成功です。

6. テスト方法 (How to Test)
tools/dummy_data_sender.pyスクリプトを使って、システム全体の動作をエンドツーエンドでテストできます。

テスト用ライブラリのインストール:
WSL2のターミナルで、プロジェクトのルートディレクトリに移動し、以下を実行します。

pip install websocket-client requests

テストスクリプトの実行:

python3 tools/dummy_data_sender.py
