Collector サービス 単体テスト実行ガイド
このガイドでは、collector サービスを単独で起動し、その入出力を検証するテストスクリプトの実行方法を説明します。

1. 前提条件
   Docker と Docker Compose がインストールされていること。

Node.js と npm がインストールされていること。

ターミナル（コマンドプロンプトや PowerShell など）が利用できること。

2. 準備
   ステップ 1: 依存パッケージのインストール
   collector ディレクトリに移動し、テストに必要なライブラリをインストールします。

cd collector
npm install

ステップ 2: サービスの起動
リポジトリのルートディレクトリ（docker-compose.yml がある場所）に戻り、collector サービスとその依存先である rabbitmq を起動します。

# ルートディレクトリに移動

cd ..

# サービスをバックグラウンドで起動

docker-compose up -d rabbitmq collector

docker ps コマンドを実行し、eeg_rabbitmq と eeg_collector のコンテナが Up 状態で稼働していることを確認してください。

3. テストの実行
   collector ディレクトリに移動し、テストスクリプトを実行します。

cd collector
npm run test:standalone

4. 実行結果の確認
   ターミナルに以下のようなログが出力されれば、テストは成功です。

--- Test Setup ---
✅ Created dummy image: .../collector/test/dummy_image.jpg
✅ Connected to RabbitMQ.

--- Running Tests ---

▶️ Testing GET /api/v1/health...
✅ Health check successful.

▶️ Testing POST /api/v1/data...

- Sent request to /api/v1/data.
- Received message from RabbitMQ.
  ✅ Sensor data test successful.

▶️ Testing POST /api/v1/media...

- Sent request to /api/v1/media.
- Received message from RabbitMQ.
  ✅ Media data test successful.

--- Test Cleanup ---
✅ Closed RabbitMQ connection.

[RESULT] ✅ All tests passed successfully!

もしテストが失敗した場合は、エラーメッセージが表示されます。

5. サービスの停止
   テストが終わったら、起動した Docker コンテナを停止・削除します。

# ルートディレクトリで実行

docker-compose down
