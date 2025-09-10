# EEG Data Collection & BIDS Export System

## 1\. 概要 (Overview)

本システムは、カスタム ESP32 脳波計やその他の生体計測デバイスから送られてくる時系列データ（EEG, IMU 等）をリアルタイムで収集し、科学研究で標準的な**BIDS (Brain Imaging Data Structure)形式**でのエクスポートを可能にする、スケーラブルなバックエンドサーバーです。

マイクロサービスアーキテクチャを採用しており、各機能が独立したコンテナとして動作するため、高い可用性とメンテナンス性を実現しています。

### 主な機能

- **リアルタイムデータ収集:** WebSocket を通じて、低遅延で連続的な生体信号データを受信。
- **非同期処理パイプライン:** RabbitMQ メッセージキューを利用し、大量のデータを安定して処理。
- **時系列データベース:** TimescaleDB (PostgreSQL 拡張) を採用し、膨大なセンサーデータを効率的に格納・クエリ。
- **BIDS 自動エクスポート:** 収集した実験データとイベント情報を紐付け、BIDS 規約に準拠した形式で自動出力。
- **リアルタイム解析:** 受信データの一部をリアルタイムで解析（PSD、同期度）し、クライアントアプリでの可視化をサポート。

## 2\. システムアーキテクチャ (System Architecture)

本システムは 7 つの独立した Docker コンテナで構成され、`docker-compose.yml`によって連携して動作します。

### サービス一覧

| サービス              | コンテナ名               | 役割                                                                                                                                                       |
| :-------------------- | :----------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingress**           | `erp_ingress`            | **API ゲートウェイ (Nginx)**。全ての外部リクエストを受け付け、適切なサービスに振り分ける。WebSocket 通信のプロキシも担当。                                 |
| **Collector**         | `erp_collector`          | **データ受信 API (Node.js)**。WebSocket (EEG/IMU) と HTTP (メディア) の両方からデータを受信し、一切の処理をせず即座に RabbitMQ へ転送する。                |
| **Processor**         | `eeg-server-processor-n` | **データ処理ワーカー (Python)**。RabbitMQ から生データを受信し、解凍・パース・タイムスタンプ計算を行い、TimescaleDB に格納する。CPU 負荷の高い処理を担う。 |
| **BIDS Manager**      | `erp_bids_manager`       | **実験管理・BIDS エクスポート API (Python/Flask)**。実験の開始/終了、イベント CSV の登録、BIDS エクスポートの非同期実行を管理する。                        |
| **Realtime Analyzer** | `erp_realtime_analyzer`  | **リアルタイム解析 API (Python/Flask)**。処理済みの脳波データを購読し、PSD や同期度を計算してアプリに結果を提供する。                                      |
| **Database**          | `erp_db`                 | **時系列データベース (TimescaleDB)**。全ての実験メタデータ、脳波・IMU データ、イベント情報を永続化する。                                                   |
| **Message Queue**     | `erp_rabbitmq`           | **メッセージブローカー (RabbitMQ)**。サービス間のデータの受け渡しを非同期で行い、システム全体の安定性を担保する。                                          |

## 3\. データフローとスキーマ詳細 (Data Flow & Schema Details)

本セクションでは、データがシステムを通過する各段階でのフォーマット、スキーマ、およびその設計判断の根拠を詳述します。

### 3.1 ESP32 -\> Smartphone: 生データパケット (Raw Data Packet)

デバイスから送信されるデータは、ペイロードサイズを最小化し、転送効率を最大化するために、厳密に定義されたバイナリ形式を取ります。

#### 3.1.1 パケット構造

ESP32 は 0.5 秒ごとに、以下の 2 つの要素を結合した**6802 バイト**の生データブロックを生成します。

1. **PacketHeader (18 バイト):**
   - `deviceId[18]`: `char`型。デバイスの MAC アドレスを文字列として格納 (`"XX:XX:XX:XX:XX:XX\0"`)。これにより、サーバーはどの物理デバイスからのデータかを一意に識別できます。
2. **SensorData Array (6784 バイト):**
   - 1 サンプルあたり 53 バイトの`SensorData`構造体が**128 個**連続して配置されます (256Hz \* 0.5s = 128 samples)。

#### 3.1.2 SensorData 構造体 (53 バイト/サンプル)

`__attribute__((packed))`を指定し、コンパイラによるパディングを排除することで、定義通りのサイズを保証します。データはすべてリトルエンディアンでパックされます。

| フィールド     | 型            | サイズ | 説明と実装根拠                                                                                                                                                   |
| :------------- | :------------ | :----- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eeg`          | `uint16_t[8]` | 16     | 8ch の EEG データ。ADC の分解能(例: 12bit)を考慮し、符号なし 16bit 整数として格納。                                                                              |
| `accel`        | `float[3]`    | 12     | 3 軸加速度。物理量を直接表現するため`float`を採用。                                                                                                              |
| `gyro`         | `float[3]`    | 12     | 3 軸角速度。同上。                                                                                                                                               |
| `trigger`      | `uint8_t`     | 1      | 外部刺激の有無を示すマーカー。`0`か`1`のみを格納するため、最小の`uint8_t`を使用。                                                                                |
| `impedance`    | `int8_t[8]`   | 8      | 各電極のインピーダンスステータス。単純な良/不良だけでなく、将来的に複数レベルの状態を表現できるよう符号付き整数を採用。                                          |
| `timestamp_us` | `uint32_t`    | 4      | **[最重要]** デバイス起動からのマイクロ秒カウンタ。ネットワーク遅延の影響を受けない単調増加の時刻源であり、サーバー側での正確な UTC 時刻復元の基準点となります。 |

#### 3.1.3 圧縮と送信フォーマット

- **圧縮:** 生成された 6802 バイトのブロック全体が**Zstandard**で一括圧縮されます。Zstandard は、リアルタイム性が求められるストリーミングデータにおいて、圧縮率と速度のバランスに優れているため採用しました。
- **送信フォーマット:** `[圧縮後サイズ(4バイト)] + [圧縮済みデータ本体]` という形式で BLE 送信されます。これにより、受信側は最初に 4 バイトを読むだけで、後続のデータ本体のサイズを正確に知ることができます。

### 3.2 Smartphone -\> Collector: WebSocket ペイロード

スマホアプリは、BLE で受信した圧縮済みデータを**一切解釈せず**、そのまま WebSocket を通じてサーバーに転送します。

- **プロトコル:** WebSocket (`ws://`)。低遅延かつ双方向通信が可能であり、連続的なデータストリームの転送に最適です。
- **ペイロード:** アプリは受信した`[圧縮後サイズ(4バイト)] + [圧縮済みデータ本体]`というバイナリデータを、さらに JSON オブジェクトでラップして送信します。

  ```json
  {
    "device_id": "8C:BF:EA:8F:3D:E0", // 解凍せずともわかるように、アプリが付与
    "server_received_timestamp": "2025-09-05T11:22:33.123Z", // アプリが受信した時刻
    "payload": "base64エンコードされた圧縮済みバイナリデータ..."
  }
  ```

- **実装根拠:** この形式により、**Collector**サービスはペイロードの中身（`payload`）を解釈する必要がなくなり、メッセージを RabbitMQ に転送するだけの極めて軽量なプロキシとして機能できます。これにより、システムの入り口でのボトルネックを排除します。

### 3.3 Collector -\> RabbitMQ: メッセージスキーマ

**Collector**は受信した JSON をそのまま RabbitMQ の`raw_data_exchange` (topic exchange) へ Publish します。

- **Routing Key:** `eeg.raw`
- **Message Body:** Smartphone から受信した JSON オブジェクトと同一。
- **実装根拠:** `topic` exchange を採用することで、将来的に「特定のデバイス ID のデータだけを購読する」(`eeg.raw.DEV001`のような)ルーティングや、「全生データをロギングする」(`eeg.raw.#`を購読)といった、柔軟な拡張が可能になります。メッセージを`durable`（永続的）に設定することで、万が一 Processor がダウンしてもデータが失われないことを保証します。

### 3.4 Processor -\> Database: データベーススキーマと格納ロジック

**Processor**がこのシステムのデータ処理における心臓部です。

#### 3.4.1 格納ロジック

1. **タイムスタンプ復元:** Processor は、メッセージ内の`server_received_timestamp`と、解凍したデータ内の最後の`timestamp_us`を比較し、その差分からデバイスの\*\*推定起動時刻 (Estimated Boot Time)\*\*を算出します。この推定起動時刻に、各サンプルの`timestamp_us`を加算することで、ネットワーク遅延を補正した極めて正確な UTC タイムスタンプを復元します。
2. **データ分割:** 1 つのパケットに含まれる 128 個のサンプルは、それぞれ正規化された上で`eeg_raw_data`テーブルと`imu_raw_data`テーブルに分割して格納されます。
3. **実験 ID の紐付け:** 各サンプルを DB に挿入する際、`experiments`テーブルを検索し、その`device_id`に現在進行中（`end_time`が NULL）の実験があれば、その`experiment_id`をレコードに付与します。

#### 3.4.2 データベーススキーマ (TimescaleDB)

- **`experiments`**

  - `experiment_id` (UUID, PK): 一意な実験 ID。
  - `participant_id` (TEXT): 被験者 ID (`sub-xx`)。
  - `device_id` (TEXT): 使用されたデバイスの MAC アドレス。
  - `start_time` / `end_time` (TIMESTAMPTZ): **[重要]** タイムゾーン情報を含む`TIMESTAMPTZ`型を使用し、全世界のどこで実験が行われても時刻の曖昧さを排除します。
  - `metadata` (JSONB): サンプリング周波数、チャンネル名など、BIDS 生成に必要な静的情報。インデックスが効く`JSONB`を採用。

- **`eeg_raw_data` (Hypertable)**

  - `timestamp` (TIMESTAMPTZ, PK): **[最重要]** TimescaleDB の Hypertable の主キー。この列で自動的にパーティショニングされます。
  - `device_id` (TEXT, PK): 複合主キーの一部。
  - `experiment_id` (UUID, FK): `experiments`テーブルへの外部キー。NULL を許容。
  - `eeg_values` (SMALLINT[]): 8ch 分の EEG 値。PostgreSQL の配列型`SMALLINT[]`を使うことで、1 レコードに全チャンネルの値を効率的に格納し、ストレージとクエリ性能を両立させます。
  - `impedance_values` (SMALLINT[]): 同上。
  - `trigger_value` (SMALLINT): `0`または`1`。

- **`experiment_events`**

  - `event_id` (BIGSERIAL, PK): イベントの主キー。
  - `experiment_id` (UUID, FK): どの実験に属するイベントかを示す。
  - `onset` (DOUBLE PRECISION): **[重要]** 記録開始からの経過**秒数**。BIDS 規約に準拠。
  - `duration` (DOUBLE PRECISION): イベントの持続時間（秒）。
  - `description` (TEXT): イベントの内容 (`target/image.jpg`など)。

## 4\. API エンドポイント (API Endpoints)

Ingress (Nginx) は以下のエンドポイントを公開します。

- `ws://<host>:8080/api/v1/eeg`

  - **メソッド:** WebSocket
  - **サービス:** `collector`
  - **役割:** ESP32 からの圧縮済み生体信号データを受信します。

- `/api/v1/experiments`

  - **メソッド:** `POST`
  - **サービス:** `bids_manager`
  - **役割:** 新しい実験セッションを開始します。

- `/api/v1/experiments/{experiment_id}/events`

  - **メソッド:** `POST`
  - **サービス:** `bids_manager`
  - **役割:** イベントが記述された CSV ファイルをアップロードし、実験を終了します。

- `/api/v1/experiments/{experiment_id}/export`

  - **メソッド:** `POST`
  - **サービス:** `bids_manager`
  - **役割:** 指定された実験の BIDS エクスポートタスクを開始します。

- `/api/v1/export-tasks/{task_id}`

  - **メソッド:** `GET`
  - **サービス:** `bids_manager`
  - **役割:** BIDS エクスポートタスクの進捗状況を確認します。

- `/api/v1/analysis/results`

  - **メソッド:** `GET`
  - **サービス:** `realtime_analyzer`
  - **役割:** 最新のリアルタイム解析結果（PSD/同期度の画像）を取得します。

## 5\. 実行方法 (Getting Started)

### 前提条件

- WSL2 (Ubuntu 推奨)
- Docker Engine
- Docker Compose

### 手順

1. **リポジトリのクローン:**

   ```bash
   git clone <repository_url>
   cd eeg-server
   ```

2. **.env ファイルの作成:**
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

3. **コンテナのビルドと起動:**
   以下のコマンドで、全サービスの Docker イメージをビルドし、バックグラウンドで起動します。

   ```bash
   docker compose up --build -d
   ```

4. **起動状態の確認:**

   ```bash
   docker compose ps
   ```

   全てのサービスの`STATUS`が`running`または`running (healthy)`になっていれば成功です。

### 開発者向けセットアップ（VSCode/WSL2 ｜フォーマッタ/リンタ）

本リポジトリは、Ruff（Python）、ESLint（TypeScript）、Prettier（TS/JS）の統一設定をルートに配置しています。
VSCode on WSL2 を前提に、以下の手順で保存時フォーマットと自動修正を有効化してください。

1. VSCode 拡張機能（WSL 側にインストール）

   - Python（ID: `ms-python.python`）
   - Pylance（ID: `ms-python.vscode-pylance`）
   - Ruff（ID: `charliermarsh.ruff`）
   - ESLint（ID: `dbaeumer.vscode-eslint`）
   - Prettier - Code formatter（ID: `esbenp.prettier-vscode`）
   - Remote - WSL（WSL で VSCode を使用する場合）

2. Python ツール（エディタ用 .venv ｜ uv 推奨）

   - 実行は Docker で行う一方、VSCode で「ライブラリが見つからない」警告を避けるため、
     ルートにエディタ専用の `.venv` を用意します（Pylance 用）。uv で一括作成できます。

     ```bash
     # bash で実行してください（sh ではなく）
     bash tools/dev/setup_py_dev_venv.sh
     # Windows の場合は .venv\Scripts\python.exe がインタプリタパス
     ```

   - VSCode のインタプリタは `.venv/bin/python` を選択してください（`.vscode/settings.json` に既定値を設定済み）。
     この .venv はエディタ解析専用であり、Docker 実行には影響しません。

   - 補足（$ROOT_DIR について）: 開発用シェルスクリプトは、スクリプト自身の場所からプロジェクトルートを判定して `cd` するため、
     どのディレクトリから実行しても同じように動きます（`.venv` の作成場所や相対パスの解決が安定します）。
     常に `eeg-server` 直下で実行する運用でも問題ありません（例: `cd eeg-server && bash tools/dev/setup_py_dev_venv.sh`）。

3. Node/TypeScript ツール（collector ディレクトリ）

   - Node.js は LTS (>=18) を推奨

   - エディタ用モジュール解決（必須・実行は Docker に非依存）

     VSCode が `import` を解決できるよう、`collector` にローカルの `node_modules` を用意します。
     ランタイムは Docker 側で完結するため、これはエディタ専用の導入です（`.gitignore` 済み）。

     ```bash
     cd collector
     npm install --no-package-lock
     ```

     補足: `.vscode/settings.json` で `typescript.tsdk` を `collector/node_modules/typescript/lib` に設定済みです。

   - Lint/Format のための開発依存（CLI 実行や VSCode の ESLint 拡張で必要）

     ESLint Flat Config（`eslint.config.mjs`）を利用します。必要なパッケージを追加してください。

     ```bash
     cd collector
     npm i -D eslint @eslint/js typescript-eslint eslint-config-prettier prettier globals
     ```

   - 用意済みのスクリプト（collector 内）

     ```bash
     # 整形（Prettier）
     npm run format
     # Lint（ESLint）
     npm run lint
     # 自動修正付き Lint
     npm run lint:fix
     ```

4. 保存時フォーマット/自動修正

   - ルートの `.vscode/settings.json` で設定済み
     - Python: Ruff をフォーマッタとして使用し、保存時に `fixAll` と import 整理を実行
     - TypeScript/JavaScript: Prettier をフォーマッタ、ESLint を保存時 Fix に使用

5. ルールと設定の所在（統一）

   - Python: `pyproject.toml`（Ruff）
   - TypeScript: `eslint.config.mjs`（ESLint Flat Config）
   - 共有フォーマット: `prettier.config.cjs` / `.prettierignore`
   - エディタ基本設定: `.editorconfig`

6. 手動実行の例（リポジトリルート）

   ```bash
   # Python 全体を整形・チェック
   ruff format .
   ruff check . --fix

   # TypeScript（collector 配下）
   (cd collector && npm run lint:fix && npm run format)
   ```

## 6\. テスト方法 (How to Test)

`tools/dummy_data_sender.py`スクリプトを使って、システム全体の動作をエンドツーエンドでテストできます。

1. **テストの自動実行（インストール込み）:**
   下記コマンドで、必要ライブラリの導入とテスト実行までを自動化しています（uv 使用）。

   ```bash
   # bash で実行してください（sh ではなく）
   bash tools/dev/run_e2e_test.sh
   ```

   仕組み: ルートのエディタ用 `.venv` を作成/更新し、`tools/requirements.test.txt`（`requests`, `websocket-client`, `zstandard`）を追加でインストールしてから、`tools/dummy_data_sender.py` を実行します。

   - サーバの Docker 上での立ち上げから行いたい場合は、Compose の起動とヘルスチェックも含めて実行できます。

     ```bash
     # ビルド込みで docker compose up -d 実行 → ヘルス待ち → テスト
     bash tools/dev/run_e2e_test.sh --compose

     # 既存のイメージを使い、ビルドを省略
     bash tools/dev/run_e2e_test.sh --compose --no-build
     ```

     スクリプトは RabbitMQ/DB のヘルス（container_name: `erp_rabbitmq`, `erp_db`）を待機し、
     さらに `http://localhost:${NGINX_PORT}/api/v1/health`（デフォルト 8080）へ到達可能になるまで待機します。
     `.env` のポート設定を読み込みます。

   補足（$ROOT_DIR について）: テスト用スクリプトも実行位置に依存せず動作します。`eeg-server` 直下から実行しても、他ディレクトリから相対/絶対パスで呼び出しても問題ありません。

2. **（代替）手動実行:**

   ```bash
   # 依存導入
   uv pip install -r tools/requirements.test.txt
   # 実行
  .venv/bin/python tools/dummy_data_sender.py
   ```

   スクリプトが実験の開始から BIDS エクスポート要求までを自動で行い、ターミナルに進捗が表示されます。

3. **結果の確認:**
   テスト完了後、ホストマシンの`bids_output`ディレクトリに BIDS 形式のファイル群が生成されていることを確認してください。

## 7\. 今後の改良点 (Future Improvements)

- **`onset`計算の厳密化:** 現在`bids_manager`は DB からトリガ信号のタイムスタンプを取得していますが、より高精度な ERP 解析のためには、サンプリング周波数を考慮してサンプル番号レベルでの`onset`計算を実装することが望ましいです。
- **認証・認可:** 現状は認証機能がありません。本番運用では、API Gateway レベルで JWT 認証などを導入する必要があります。
- **MUSE 2 対応:** `processor`サービスに、MUSE 2 など他デバイスからの非圧縮データを受信した際の処理分岐を追加します。

## Processor 設定（パフォーマンス関連）

Processor は以下の環境変数で処理パスを切り替えられます（デフォルトは高速化が有効）。

- `PROCESSOR_USE_NUMPY` (0/1, default 1): NumPy の構造化 dtype + `np.frombuffer` によるベクトル化パースを有効にします。
- `PROCESSOR_USE_COPY` (0/1, default 1): `psycopg` v3 の `COPY FROM STDIN BINARY` を使って一括投入します。
- `PROCESSOR_COPY_BATCH` (int, default 10000): 将来のメッセージ集約時のパラメータ（現状はメッセージ単位で逐次 COPY）。

動作要件:
- `processor/requirements.txt` は `psycopg[binary]` と `numpy` を含みます。`psycopg2-binary` は不要になりました。

注意:
- ACK は DB コミット後に発行されます。例外発生時は `basic_nack(requeue=true)` で再処理されます。
