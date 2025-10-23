# EEG Data Collection & BIDS Export System

## 1\. 概要 (Overview)

本システムは、カスタム ESP32 脳波計やその他の生体計測デバイスから送られてくる時系列データ（EEG, IMU 等）をリアルタイムで収集し、科学研究で標準的な**BIDS (Brain Imaging Data Structure)形式**でのエクスポートを可能にする、スケーラブルなバックエンドサーバーです。

マイクロサービスアーキテクチャを採用しており、各機能が独立したコンテナとして動作するため、高い可用性とメンテナンス性を実現しています。

### 主な機能

- **リアルタイムデータ収集:** HTTP API を通じて、連続的な生体信号データを受信。
- **非同期処理パイプライン:** RabbitMQ メッセージキューを利用し、大量のデータを安定して処理。
- **時系列データベース:** TimescaleDB (PostgreSQL 拡張) を採用し、膨大なセンサーデータを効率的に格納・クエリ。
- **BIDS 自動エクスポート:** 収集した実験データとイベント情報を紐付け、BIDS 規約に準拠した形式で自動出力。
- **リアルタイム解析:** 受信データの一部をリアルタイムで解析（PSD、同期度）し、クライアントアプリでの可視化をサポート。

## 2\. システムアーキテクチャ (System Architecture)

本システムは 6 つの独立した Docker サービスで構成され、`docker-compose.yml`によって連携して動作します。
また、Processor サービスは 2 つのレプリカで並列実行されます。

### サービス一覧

| サービス              | コンテナ名               | 役割                                                                                                                                                      |
| :-------------------- | :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingress**           | `eeg_ingress`            | **API ゲートウェイ (Nginx)**。HTTP リクエストを受け付け、適切なサービスに振り分ける。                                                                     |
| **Collector**         | `eeg_collector`          | **データ受信 API (Node.js)**。HTTP 経由でセンサーデータとメディアファイルを受信し、一切の処理をせず即座に RabbitMQ へ転送する。                           |
| **Processor**         | `eeg-server-processor-*` | **データ処理ワーカー (Python)**。RabbitMQ から生データを受信し、解凍・パース・タイムスタンプ計算を行い、PostgreSQL に格納する。2 つのレプリカで並列実行。 |
| **BIDS Exporter**     | `bids_exporter`          | **実験管理・BIDS エクスポート API (Python/FastAPI)**。実験の開始/終了、イベント登録、BIDS エクスポートの非同期実行を管理する。                            |
| **Realtime Analyzer** | `eeg_realtime_analyzer`  | **リアルタイム解析 API (Python/Flask)**。処理済みの脳波データを購読し、PSD や同期度を計算してアプリに結果を提供する。                                     |
| **Database**          | `eeg_db`                 | **PostgreSQL データベース (TimescaleDB 拡張)**。実験メタデータ、セッション情報、イベント情報、メディアファイル情報を永続化する。                          |
| **Message Queue**     | `eeg_rabbitmq`           | **メッセージブローカー (RabbitMQ)**。サービス間のデータの受け渡しを非同期で行い、システム全体の安定性を担保する。                                         |
| **Observability Dashboard** | `observability_dashboard` | **可視化/監査サービス (Bun/Hono)**。RabbitMQ/DB/オブジェクトストレージ (SeaweedFS) とサービス間のデータフロー・タスク状況をブラウザで確認できる。 |

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

### 3.2 Smartphone -\> Collector: HTTP ペイロード

スマホアプリは、BLE で受信した圧縮済みデータを**一切解釈せず**、HTTP POST リクエストのペイロードとして`ingress`サービスに送信します。

- **プロトコル:** HTTP POST。モバイルアプリからの送信が容易で、多くのライブラリでサポートされています。

- **エンドポイント:** `/api/v1/data`

- **ペイロード:** アプリは受信した圧縮済みバイナリデータを Base64 エンコードし、JSON オブジェクトでラップして送信します。

  ```json
  {
    "user_id": "user-default-01",
    "payload_base64": "base64エンコードされた圧縮済みバイナリデータ..."
  }
  ```

- **実装根拠:** この形式により、**Collector**サービスはペイロードの中身を解釈する必要がなくなり、メッセージを RabbitMQ に転送するだけの極めて軽量なプロキシとして機能できます。

### 3.3 Collector -\> RabbitMQ: メッセージスキーマ

**Collector**は受信した生バイナリデータを`raw_data_exchange` (fanout exchange) へ Publish します。

- **Exchange Type:** `fanout`
- **Message Body:** Base64 デコードされた圧縮済みバイナリデータ本体。
- **Message Headers:** `{ "user_id": "user-default-01" }`
- **実装根拠:** `fanout` exchange を採用することで、単一の生データを**永続化処理 (`Processor`)とリアルタイム解析 (`Realtime Analyzer`)** の両方が同時に、かつ独立して受信できます。これにより、サービスの関心を完全に分離しています。

### 3.4 Processor -\> Database: データベーススキーマと格納ロジック

**Processor**がこのシステムのデータ処理における心臓部です。

#### 3.4.1 格納ロジック

1. **タイムスタンプ復元:** Processor は、メッセージ内の`server_received_timestamp`と、解凍したデータ内の最後の`timestamp_us`を比較し、その差分からデバイスの\*\*推定起動時刻 (Estimated Boot Time)\*\*を算出します。この推定起動時刻に、各サンプルの`timestamp_us`を加算することで、ネットワーク遅延を補正した極めて正確な UTC タイムスタンプを復元します。
2. **データ分割:** 1 つのパケットに含まれる 128 個のサンプルは、それぞれ正規化された上でセッション管理用のテーブル群に格納されます。
3. **セッションリンキング:** 受信した生データは `raw_data_objects` テーブルに登録され、時間範囲に基づいて相当するセッションとリンクされます。

#### 3.4.2 データベーススキーマ (PostgreSQL + TimescaleDB 拡張)

本システムでは、セッションベースのデータ管理アーキテクチャを採用しています：

- **`experiments`**: 実験の管理テーブル

  - `experiment_id` (UUID, PK): 一意な実験 ID
  - `name` (VARCHAR): 実験名
  - `description` (TEXT): 実験の説明

- **`sessions`**: 測定セッションの管理テーブル

  - `session_id` (VARCHAR, PK): セッションの一意 ID
  - `user_id` (VARCHAR): ユーザー ID
  - `experiment_id` (UUID, FK): 所属する実験
  - `device_id` (VARCHAR): 使用デバイス ID
  - `start_time` / `end_time` (TIMESTAMPTZ): セッションの開始・終了時刻
  - `session_type` (VARCHAR): セッションタイプ
  - `link_status` (VARCHAR): リンキング状態 (pending/processing/completed/failed)

- **`events`**: イベントマーカーの管理テーブル

  - `id` (BIGSERIAL, PK): イベント ID
  - `session_id` (VARCHAR, FK): 所属セッション
  - `onset` (DOUBLE PRECISION): セッション開始からの経過秒数
  - `duration` (DOUBLE PRECISION): 持続時間（秒）
  - `description` (TEXT): イベントの説明
  - `value` (VARCHAR): イベント値 (stimulus/left, t-posed など)

- **`raw_data_objects`**: 生データオブジェクトのメタデータテーブル

  - `object_id` (VARCHAR, PK): オブジェクトの一意 ID
  - `user_id` (VARCHAR): ユーザー ID
  - `device_id` (VARCHAR): デバイス ID
  - `start_time` / `end_time` (TIMESTAMPTZ): データの時間範囲

- **`session_object_links`**: セッションと生データのリンキングテーブル

  - `session_id` (VARCHAR, FK): セッション ID
  - `object_id` (VARCHAR, FK): オブジェクト ID
  - 複合主キー: (session_id, object_id)

- **`images`**: 画像ファイルのメタデータテーブル

  - `object_id` (VARCHAR, PK): オブジェクト ID
  - `user_id` (VARCHAR): ユーザー ID
  - `session_id` (VARCHAR): 関連セッション ID
  - `experiment_id` (UUID, FK): 関連実験 ID
  - `timestamp_utc` (TIMESTAMPTZ): 撮影時刻

- **`audio_clips`**: 音声ファイルのメタデータテーブル
  - `object_id` (VARCHAR, PK): オブジェクト ID
  - `user_id` (VARCHAR): ユーザー ID
  - `session_id` (VARCHAR): 関連セッション ID
  - `experiment_id` (UUID, FK): 関連実験 ID
  - `start_time` / `end_time` (TIMESTAMPTZ): 録音の時間範囲

## 4\. API エンドポイント (API Endpoints)

Ingress (Nginx) は以下のエンドポイントを公開します。

### 現在利用可能なエンドポイント

- `/api/v1/data`

  - **メソッド:** `POST`
  - **サービス:** `collector`
  - **役割:** スマートフォンアプリからの圧縮済みセンサーデータを受信

- `/api/v1/media`

  - **メソッド:** `POST`
  - **サービス:** `collector`
  - **役割:** スマートフォンアプリからの画像・音声データを受信

- `/api/v1/timestamps/sync`

  - **メソッド:** `POST`
  - **サービス:** `collector`
  - **役割:** タイムスタンプ同期用エンドポイント

- `/api/v1/users/`

  - **メソッド:** `GET`
  - **サービス:** `realtime_analyzer`
  - **役割:** リアルタイム解析結果の取得

- `/api/v1/health`
  - **メソッド:** `GET`
  - **サービス:** `collector`
  - **役割:** システムヘルスチェック

### ⚠️ 現在利用不可なエンドポイント

以下の BIDS Exporter サービスのエンドポイントは、nginx のルーティング設定が未完成のため、外部からアクセスできません：

- `/api/v1/experiments` (実験管理)
- `/api/v1/experiments/{experiment_id}/events` (イベント登録)
- `/api/v1/experiments/{experiment_id}/export` (BIDS エクスポート)
- `/api/v1/export-tasks/{task_id}` (エクスポート状態確認)

## 5\. 実行方法 (Getting Started)

### 前提条件

- WSL2 (Ubuntu 推奨)
- Docker Engine
- Docker Compose

### 5.1 基本セットアップ

1. **リポジトリのクローン:**

   ```bash
   git clone <repository_url>
   cd eeg-server
   ```

2. **開発ツールのインストール:**
   プロジェクトは `.mise.toml` で Bun / Python / uv のバージョンを管理しています。以下を実行して必要ツールを導入してください。

   ```bash
   mise install
   ```

3. **JavaScript 依存のインストール (Bun Workspaces):**
   ルートの `package.json` にワークスペースが定義されているため、1 回の `bun install` で全サービス分の依存パッケージがセットアップされます。

   ```bash
   bun install
   ```

4. **.env ファイルの作成:**
   共有デフォルトは `.env.example` にまとまっています。以下を参考に必要なテンプレートをコピーしてください。

   ```bash
   cp .env.example .env
   cp .env.local.example .env.local   # 任意: 開発者ごとの秘密情報を分離
   ```

5. **コンテナのビルドと起動:**
   開発環境では、ベース定義に `docker-compose.development.yml` を重ねることでローカル専用の volume mount を有効化します。

   ```bash
   docker compose -f docker-compose.yml \
     -f docker-compose.development.yml \
     up --build -d
   ```

   `.env.local` を作成した場合は `docker compose --env-file .env.local -f ...` のように `--env-file` を追加してください。

### 5.2 モバイルアプリ連携のための開発環境設定（WSL2 + Windows）

スマートフォン実機やエミュレータから、WSL2 上の Docker コンテナへ接続するには、**PC のネットワーク設定が必須**です。

#### なぜ設定が必要か？

WSL2 は Windows とは別の仮想ネットワークを持つため、スマホから PC の IP アドレスにアクセスしても、その通信は WSL 内部まで届きません。これを解決するため、**ポートフォワーディング**と**ファイアウォール設定**の 2 つを行います。

#### ステップ 1: 必要な IP アドレスを 2 つ調べる

1. **Windows の IP アドレスを確認:**

   - Windows の**コマンドプロンプト**で`ipconfig`を実行し、「IPv4 アドレス」をメモします。（例: `192.168.128.151`）

2. **WSL の IP アドレスを確認:**

   - **WSL のターミナル**で`hostname -I`または`ip -4 a`を実行し、`eth0`の`inet`アドレスをメモします。（例: `172.26.232.13`）

#### ステップ 2: ポートフォワーディングを設定する

Windows に来た通信を WSL へ転送するルールを追加します。

1. \*\*PowerShell を「管理者として実行」\*\*します。

2. 以下のコマンドの`<...>`部分を、ステップ 1 で調べた IP アドレスに置き換えて実行します。

   ```powershell
   # 構文: netsh interface portproxy add v4tov4 listenport=<公開ポート> listenaddress=<WindowsのIP> connectport=<転送先ポート> connectaddress=<WSLのIP>
   netsh interface portproxy add v4tov4 listenport=8080 listenaddress=192.168.128.151 connectport=8080 connectaddress=172.26.232.13
   ```

#### ステップ 3: Windows Defender ファイアウォールの設定

外部（スマホ）からの通信を許可するルールを追加します。

1. \*\*PowerShell を「管理者として実行」\*\*します。

2. 以下のコマンドを実行し、ポート`8080`への受信（Inbound）を許可します。

   ```powershell
   New-NetFirewallRule -DisplayName "WSL Port 8080 Allow" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
   ```

これで、スマホアプリの`.env`ファイルに`SERVER_IP=<WindowsのIP>`と`SERVER_PORT=8080`を設定すれば、通信が可能になります。

---

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

   - スクリプト内では `pyproject.toml` の optional dependencies（`.[bids_exporter]`, `.[realtime_analyzer]`, `.[erp_neuro_marketing]`, `.[analysis]`）を uv 経由でまとめてインストールします。各 Python サービスの補完や型チェックが `.venv` で利用可能になります。

   - 補足（$ROOT_DIR について）: 開発用シェルスクリプトは、スクリプト自身の場所からプロジェクトルートを判定して `cd` するため、
     どのディレクトリから実行しても同じように動きます（`.venv` の作成場所や相対パスの解決が安定します）。
     常に `eeg-server` 直下で実行する運用でも問題ありません（例: `cd eeg-server && bash tools/dev/setup_py_dev_venv.sh`）。

3. Node/TypeScript ツール（Bun Workspaces）

   - `bun install` はワークスペース一括対応のため、追加でサービス直下に `npm install` 等を行う必要はありません。
   - VSCode や他エディタもルート `node_modules` を参照して型補完が機能します。
   - サービス固有のスクリプトは `bun run --filter <service> <script>` 形式で実行できます。

     ```bash
     # 例: collector の dev サーバー
     bun run --filter collector dev

     # 例: integration_test のテスト
     bun run --filter integration_test test
     ```

   - ローカルで追加依存を導入したい場合も、ルートで `bun add <pkg> --filter <service>` を利用すると、該当サービスの `package.json` のみに反映されます。

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

### 6.1 Collector サービスの単体テスト

`collector`サービス単体の動作を、RabbitMQ と連携して確認します。

1. **必要なサービスを起動:**

   ```bash
   docker-compose up -d rabbitmq collector
   ```

2. **テストスクリプトを実行:**
   `collector`ディレクトリに移動し、依存パッケージをインストールしてからテストを実行します。

   ```bash
   cd collector
   npm install
   npm run test:standalone
   ```

3. ターミナルに`✅ All tests passed successfully!`と表示されれば成功です。

### 6.2 エンドツーエンドテスト

`tools/dummy_data_sender.py`スクリプトを使って、システム全体の動作をテストできます。

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

     スクリプトは RabbitMQ/DB のヘルス（container_name: `eeg_rabbitmq`, `eeg_db`）を待機し、
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

- **`onset`計算の厳密化:** 現在`bids_exporter`は DB からトリガ信号のタイムスタンプを取得していますが、より高精度な ERP 解析のためには、サンプリング周波数を考慮してサンプル番号レベルでの`onset`計算を実装することが望ましいです。
- **認証・認可:** 現状は認証機能がありません。本番運用では、API Gateway レベルで JWT 認証などを導入する必要があります。
- **MUSE 2 対応:** `processor`サービスに、MUSE 2 など他デバイスからの非圧縮データを受信した際の処理分岐を追加します。
