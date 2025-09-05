-----

# EEG Data Collection & BIDS Export System

## 1\. 概要 (Overview)

本システムは、カスタムESP32脳波計やその他の生体計測デバイスから送られてくる時系列データ（EEG, IMU等）をリアルタイムで収集し、科学研究で標準的な**BIDS (Brain Imaging Data Structure)形式**でのエクスポートを可能にする、スケーラブルなバックエンドサーバーです。

マイクロサービスアーキテクチャを採用しており、各機能が独立したコンテナとして動作するため、高い可用性とメンテナンス性を実現しています。

### 主な機能

  - **リアルタイムデータ収集:** WebSocketを通じて、低遅延で連続的な生体信号データを受信。
  - **非同期処理パイプライン:** RabbitMQメッセージキューを利用し、大量のデータを安定して処理。
  - **時系列データベース:** TimescaleDB (PostgreSQL拡張) を採用し、膨大なセンサーデータを効率的に格納・クエリ。
  - **BIDS自動エクスポート:** 収集した実験データとイベント情報を紐付け、BIDS規約に準拠した形式で自動出力。
  - **リアルタイム解析:** 受信データの一部をリアルタイムで解析（PSD、同期度）し、クライアントアプリでの可視化をサポート。

## 2\. システムアーキテクチャ (System Architecture)

本システムは7つの独立したDockerコンテナで構成され、`docker-compose.yml`によって連携して動作します。

### サービス一覧

| サービス | コンテナ名 | 役割 |
| :--- | :--- | :--- |
| **Ingress** | `erp_ingress` | **APIゲートウェイ (Nginx)**。全ての外部リクエストを受け付け、適切なサービスに振り分ける。WebSocket通信のプロキシも担当。 |
| **Collector** | `erp_collector` | **データ受信API (Node.js)**。WebSocket (EEG/IMU) とHTTP (メディア) の両方からデータを受信し、一切の処理をせず即座にRabbitMQへ転送する。 |
| **Processor** | `eeg-server-processor-n` | **データ処理ワーカー (Python)**。RabbitMQから生データを受信し、解凍・パース・タイムスタンプ計算を行い、TimescaleDBに格納する。CPU負荷の高い処理を担う。 |
| **BIDS Manager** | `erp_bids_manager` | **実験管理・BIDSエクスポートAPI (Python/Flask)**。実験の開始/終了、イベントCSVの登録、BIDSエクスポートの非同期実行を管理する。 |
| **Realtime Analyzer**| `erp_realtime_analyzer`| **リアルタイム解析API (Python/Flask)**。処理済みの脳波データを購読し、PSDや同期度を計算してアプリに結果を提供する。 |
| **Database** | `erp_db` | **時系列データベース (TimescaleDB)**。全ての実験メタデータ、脳波・IMUデータ、イベント情報を永続化する。 |
| **Message Queue** | `erp_rabbitmq` | **メッセージブローカー (RabbitMQ)**。サービス間のデータの受け渡しを非同期で行い、システム全体の安定性を担保する。 |

## 3\. データフローとスキーマ詳細 (Data Flow & Schema Details)

本セクションでは、データがシステムを通過する各段階でのフォーマット、スキーマ、およびその設計判断の根拠を詳述します。

### 3.1 ESP32 -\> Smartphone: 生データパケット (Raw Data Packet)

デバイスから送信されるデータは、ペイロードサイズを最小化し、転送効率を最大化するために、厳密に定義されたバイナリ形式を取ります。

#### 3.1.1 パケット構造

ESP32は0.5秒ごとに、以下の2つの要素を結合した**6802バイト**の生データブロックを生成します。

1.  **PacketHeader (18バイト):**
      - `deviceId[18]`: `char`型。デバイスのMACアドレスを文字列として格納 (`"XX:XX:XX:XX:XX:XX\0"`)。これにより、サーバーはどの物理デバイスからのデータかを一意に識別できます。
2.  **SensorData Array (6784バイト):**
      - 1サンプルあたり53バイトの`SensorData`構造体が**128個**連続して配置されます (256Hz \* 0.5s = 128 samples)。

#### 3.1.2 SensorData 構造体 (53バイト/サンプル)

`__attribute__((packed))`を指定し、コンパイラによるパディングを排除することで、定義通りのサイズを保証します。データはすべてリトルエンディアンでパックされます。

| フィールド | 型 | サイズ | 説明と実装根拠 |
| :--- | :--- | :--- | :--- |
| `eeg` | `uint16_t[8]` | 16 | 8chのEEGデータ。ADCの分解能(例: 12bit)を考慮し、符号なし16bit整数として格納。 |
| `accel`| `float[3]` | 12 | 3軸加速度。物理量を直接表現するため`float`を採用。 |
| `gyro` | `float[3]` | 12 | 3軸角速度。同上。 |
| `trigger`| `uint8_t` | 1 | 外部刺激の有無を示すマーカー。`0`か`1`のみを格納するため、最小の`uint8_t`を使用。 |
| `impedance`| `int8_t[8]` | 8 | 各電極のインピーダンスステータス。単純な良/不良だけでなく、将来的に複数レベルの状態を表現できるよう符号付き整数を採用。 |
| `timestamp_us`|`uint32_t` | 4 | **[最重要]** デバイス起動からのマイクロ秒カウンタ。ネットワーク遅延の影響を受けない単調増加の時刻源であり、サーバー側での正確なUTC時刻復元の基準点となります。 |

#### 3.1.3 圧縮と送信フォーマット

  - **圧縮:** 生成された6802バイトのブロック全体が**Zstandard**で一括圧縮されます。Zstandardは、リアルタイム性が求められるストリーミングデータにおいて、圧縮率と速度のバランスに優れているため採用しました。
  - **送信フォーマット:** `[圧縮後サイズ(4バイト)] + [圧縮済みデータ本体]` という形式でBLE送信されます。これにより、受信側は最初に4バイトを読むだけで、後続のデータ本体のサイズを正確に知ることができます。

### 3.2 Smartphone -\> Collector: WebSocket ペイロード

スマホアプリは、BLEで受信した圧縮済みデータを**一切解釈せず**、そのままWebSocketを通じてサーバーに転送します。

  - **プロトコル:** WebSocket (`ws://`)。低遅延かつ双方向通信が可能であり、連続的なデータストリームの転送に最適です。
  - **ペイロード:** アプリは受信した`[圧縮後サイズ(4バイト)] + [圧縮済みデータ本体]`というバイナリデータを、さらにJSONオブジェクトでラップして送信します。
    ```json
    {
      "device_id": "8C:BF:EA:8F:3D:E0", // 解凍せずともわかるように、アプリが付与
      "server_received_timestamp": "2025-09-05T11:22:33.123Z", // アプリが受信した時刻
      "payload": "base64エンコードされた圧縮済みバイナリデータ..."
    }
    ```
  - **実装根拠:** この形式により、**Collector**サービスはペイロードの中身（`payload`）を解釈する必要がなくなり、メッセージをRabbitMQに転送するだけの極めて軽量なプロキシとして機能できます。これにより、システムの入り口でのボトルネックを排除します。

### 3.3 Collector -\> RabbitMQ: メッセージスキーマ

**Collector**は受信したJSONをそのままRabbitMQの`raw_data_exchange` (topic exchange) へPublishします。

  - **Routing Key:** `eeg.raw`
  - **Message Body:** Smartphoneから受信したJSONオブジェクトと同一。
  - **実装根拠:** `topic` exchangeを採用することで、将来的に「特定のデバイスIDのデータだけを購読する」(`eeg.raw.DEV001`のような)ルーティングや、「全生データをロギングする」(`eeg.raw.#`を購読)といった、柔軟な拡張が可能になります。メッセージを`durable`（永続的）に設定することで、万が一Processorがダウンしてもデータが失われないことを保証します。

### 3.4 Processor -\> Database: データベーススキーマと格納ロジック

**Processor**がこのシステムのデータ処理における心臓部です。

#### 3.4.1 格納ロジック

1.  **タイムスタンプ復元:** Processorは、メッセージ内の`server_received_timestamp`と、解凍したデータ内の最後の`timestamp_us`を比較し、その差分からデバイスの\*\*推定起動時刻 (Estimated Boot Time)\*\*を算出します。この推定起動時刻に、各サンプルの`timestamp_us`を加算することで、ネットワーク遅延を補正した極めて正確なUTCタイムスタンプを復元します。
2.  **データ分割:** 1つのパケットに含まれる128個のサンプルは、それぞれ正規化された上で`eeg_raw_data`テーブルと`imu_raw_data`テーブルに分割して格納されます。
3.  **実験IDの紐付け:** 各サンプルをDBに挿入する際、`experiments`テーブルを検索し、その`device_id`に現在進行中（`end_time`がNULL）の実験があれば、その`experiment_id`をレコードに付与します。

#### 3.4.2 データベーススキーマ (TimescaleDB)

  - **`experiments`**

      - `experiment_id` (UUID, PK): 一意な実験ID。
      - `participant_id` (TEXT): 被験者ID (`sub-xx`)。
      - `device_id` (TEXT): 使用されたデバイスのMACアドレス。
      - `start_time` / `end_time` (TIMESTAMPTZ): **[重要]** タイムゾーン情報を含む`TIMESTAMPTZ`型を使用し、全世界のどこで実験が行われても時刻の曖昧さを排除します。
      - `metadata` (JSONB): サンプリング周波数、チャンネル名など、BIDS生成に必要な静的情報。インデックスが効く`JSONB`を採用。

  - **`eeg_raw_data` (Hypertable)**

      - `timestamp` (TIMESTAMPTZ, PK): **[最重要]** TimescaleDBのHypertableの主キー。この列で自動的にパーティショニングされます。
      - `device_id` (TEXT, PK): 複合主キーの一部。
      - `experiment_id` (UUID, FK): `experiments`テーブルへの外部キー。NULLを許容。
      - `eeg_values` (SMALLINT[]): 8ch分のEEG値。PostgreSQLの配列型`SMALLINT[]`を使うことで、1レコードに全チャンネルの値を効率的に格納し、ストレージとクエリ性能を両立させます。
      - `impedance_values` (SMALLINT[]): 同上。
      - `trigger_value` (SMALLINT): `0`または`1`。

  - **`experiment_events`**

      - `event_id` (BIGSERIAL, PK): イベントの主キー。
      - `experiment_id` (UUID, FK): どの実験に属するイベントかを示す。
      - `onset` (DOUBLE PRECISION): **[重要]** 記録開始からの経過**秒数**。BIDS規約に準拠。
      - `duration` (DOUBLE PRECISION): イベントの持続時間（秒）。
      - `description` (TEXT): イベントの内容 (`target/image.jpg`など)。

## 4\. APIエンドポイント (API Endpoints)

Ingress (Nginx) は以下のエンドポイントを公開します。

  - `ws://<host>:8080/api/v1/eeg`

      - **メソッド:** WebSocket
      - **サービス:** `collector`
      - **役割:** ESP32からの圧縮済み生体信号データを受信します。

  - `/api/v1/experiments`

      - **メソッド:** `POST`
      - **サービス:** `bids_manager`
      - **役割:** 新しい実験セッションを開始します。

  - `/api/v1/experiments/{experiment_id}/events`

      - **メソッド:** `POST`
      - **サービス:** `bids_manager`
      - **役割:** イベントが記述されたCSVファイルをアップロードし、実験を終了します。

  - `/api/v1/experiments/{experiment_id}/export`

      - **メソッド:** `POST`
      - **サービス:** `bids_manager`
      - **役割:** 指定された実験のBIDSエクスポートタスクを開始します。

  - `/api/v1/export-tasks/{task_id}`

      - **メソッド:** `GET`
      - **サービス:** `bids_manager`
      - **役割:** BIDSエクスポートタスクの進捗状況を確認します。

  - `/api/v1/analysis/results`

      - **メソッド:** `GET`
      - **サービス:** `realtime_analyzer`
      - **役割:** 最新のリアルタイム解析結果（PSD/同期度の画像）を取得します。

## 5\. 実行方法 (Getting Started)

### 前提条件

  - WSL2 (Ubuntu推奨)
  - Docker Engine
  - Docker Compose

### 手順

1.  **リポジトリのクローン:**

    ```bash
    git clone <repository_url>
    cd eeg-server
    ```

2.  **.envファイルの作成:**
    プロジェクトのルートディレクトリに`.env`という名前のファイルを新規作成し、以下の内容を記述します。

    ```ini
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
    ```

3.  **コンテナのビルドと起動:**
    以下のコマンドで、全サービスのDockerイメージをビルドし、バックグラウンドで起動します。

    ```bash
    docker compose up --build -d
    ```

4.  **起動状態の確認:**

    ```bash
    docker compose ps
    ```

    全てのサービスの`STATUS`が`running`または`running (healthy)`になっていれば成功です。

## 6\. テスト方法 (How to Test)

`tools/dummy_data_sender.py`スクリプトを使って、システム全体の動作をエンドツーエンドでテストできます。

1.  **テスト用ライブラリのインストール:**
    WSL2のターミナルで、プロジェクトのルートディレクトリに移動し、以下を実行します。

    ```bash
    pip install websocket-client requests
    ```

2.  **テストスクリプトの実行:**

    ```bash
    python3 tools/dummy_data_sender.py
    ```

    スクリプトが実験の開始からBIDSエクスポート要求までを自動で行い、ターミナルに進捗が表示されます。

3.  **結果の確認:**
    テスト完了後、ホストマシンの`bids_output`ディレクトリにBIDS形式のファイル群が生成されていることを確認してください。

## 7\. 今後の改良点 (Future Improvements)

  - **`onset`計算の厳密化:** 現在`bids_manager`はDBからトリガ信号のタイムスタンプを取得していますが、より高精度なERP解析のためには、サンプリング周波数を考慮してサンプル番号レベルでの`onset`計算を実装することが望ましいです。
  - **認証・認可:** 現状は認証機能がありません。本番運用では、API GatewayレベルでJWT認証などを導入する必要があります。
  - **MUSE 2対応:** `processor`サービスに、MUSE 2など他デバイスからの非圧縮データを受信した際の処理分岐を追加します。
