現在の課題:

統合テストが手動実行のみ
テスト環境のクリーンアップが不完全
テスト失敗時のロールバックが不明確
作業項目
1. 統合テストスクリプトの作成

integration_test/run-tests.shを作成

#!/bin/bash
# integration_test/run-tests.sh
set -e

echo "🧹 Cleaning up previous test environment..."
docker compose -f docker-compose.yml -f docker-compose.development.yml -f docker-compose.test.yml down -v --remove-orphans

echo "🔨 Building services (no cache)..."
docker compose -f docker-compose.yml -f docker-compose.development.yml -f docker-compose.test.yml build --no-cache

echo "🚀 Starting services and running integration tests..."
docker compose -f docker-compose.yml -f docker-compose.development.yml -f docker-compose.test.yml up --abort-on-container-exit integration-test

EXIT_CODE=$?

echo "🧹 Cleaning up test environment..."
docker compose -f docker-compose.yml -f docker-compose.development.yml -f docker-compose.test.yml down -v --remove-orphans

# Clean up images, networks (but keep build cache for speed)
docker system prune -f

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Integration tests passed"
else
  echo "❌ Integration tests failed"
fi

exit $EXIT_CODE
2. Docker Compose test 設定の作成

docker-compose.test.ymlを作成
# docker-compose.test.yml
services:
  integration-test:
    build:
      context: ./integration_test
      dockerfile: Dockerfile
    depends_on:
      ingress:
        condition: service_started
      db:
        condition: service_healthy
      minio:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
    environment:
      - BASE_URL=http://ingress/api/v1
      - DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    networks:
      - eeg-network
    command: bun test
3. 統合テスト用 Dockerfile の作成

integration_test/Dockerfileを作成

FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "test"]
4. 実行権限の付与

スクリプトに実行権限を付与
chmod +x integration_test/run-tests.sh
5. ローカルテスト

スクリプトが正常に実行されることを確認
./integration_test/run-tests.sh
完了条件

integration_test/run-tests.shが作成され、実行権限が付与されている

docker-compose.test.ymlが作成されている

integration_test/Dockerfileが作成されている

スクリプトがクリーンな環境からテストを実行できる

テスト成功時に終了コード 0 が返される

テスト失敗時に終了コード 1 が返される

テスト後に環境がクリーンアップされる

このスクリプトは GitHub Actions に統合してほしい。 

# .github/workflows/integration-test.yml
name: Integration Tests
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run integration tests
        run: ./integration_test/run-tests.sh

また，
PRマージ前の品質チェックが手動（人的ミスリスク）
型エラーやLint違反がmainブランチに混入
セキュリティ脆弱性の検出が遅れる
依存関係の更新が手動で煩雑
GitHub Actionsを導入し、自動テスト・品質チェック・セキュリティスキャンを実施することで、コード品質を保証し、開発速度を向上させます。
CI Workflow (.github/workflows/ci.yml)

Lint（TypeScript）ジョブ追加
ESLint実行、コーディング規約チェック

Lint（Python）ジョブ追加
Ruff実行、PEP8準拠チェック

型チェック（TypeScript）ジョブ追加
tsc --noEmit実行、型エラー検出

型チェック（Python）ジョブ追加
Pyright実行、型ヒント検証

統合テストジョブ追加
Docker Compose起動（docker compose up -d --wait）
ヘルスチェック確認（各サービスの/healthエンドポイント）
collector/test/standalone_test.ts実行
integration_test/src/main.test.ts実行
ログ収集（失敗時）

ビルドチェックジョブ追加
全Dockerfileのビルド検証（matrix戦略）
Security Workflow (.github/workflows/security.yml)

Trivyスキャンジョブ追加
CVE（既知脆弱性）検出
依存関係の脆弱性チェック
設定ミス検出

Dependency Reviewジョブ追加
PR内の新規依存を分析
ライセンス互換性チェック
Dependabot設定 (.github/dependabot.yml)

npm依存の自動更新設定
週次スケジュール（月曜日）
グルーピング（dev/production分離）
PR上限5件

pip依存の自動更新設定
週次スケジュール

Dockerベースイメージの自動更新設定
月次スケジュール
完了条件

PR作成時に自動でCIが実行される

Lintエラーがあるとマージできない

型エラーがあるとマージできない

テストが失敗するとマージできない

Dockerビルドが失敗するとマージできない

セキュリティスキャンが週1回実行される

Dependabotが依存更新PRを自動作成する

統合テストで全サービスのヘルスチェックが成功する

CI実行時間が10分以内

ドキュメントが更新される
CI動作確認

テストPR作成、全ジョブが実行される

Lintエラーを含むPRでジョブが失敗する

型エラーを含むPRでジョブが失敗する

テスト失敗でジョブが失敗する

正常なPRで全ジョブが成功する
セキュリティスキャン確認

Trivyが脆弱性を検出する（テスト用に古いパッケージを使用）

Dependency Reviewが新規依存を検出する
Dependabot確認

週次で依存更新PRが作成される

グルーピングが正しく動作する

PR上限が機能する
統合テスト確認

CIでdocker compose up --waitが成功する

各サービスのヘルスチェックが成功する（#33で実装済み）

integration_testが成功する
パフォーマンステスト

CI実行時間を計測

キャッシュ戦略を調整して高速化