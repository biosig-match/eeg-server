# ブランチ戦略

本プロジェクトは以下のブランチ戦略を採用しています。

## ブランチの種類

- `main`: 本番環境にデプロイされるブランチ（安定版）
- `develop`: 開発中の機能が統合されるブランチ
- `feature/*`: 新機能開発用ブランチ
- `fix/*`: バグ修正用ブランチ
- `refactor/*`: リファクタリング用ブランチ

## ワークフロー

1. `develop`から`feature/*`ブランチを作成
2. 機能を実装してコミット
3. `develop`へ PR を作成
4. レビュー・承認後にマージ
5. `develop`から`main`へ PR を作成
6. QA テスト後にマージ
7. `main`から Git Tag を作成
8. GitHub Release を作成（Production 環境へ自動デプロイ）

## デプロイフロー

- `feature/*` → PR 作成 → **Preview 環境**（`pr-{id}.dev.eeg.coolify.satou-jayo.cc`）
- `develop` → push → **Development 環境**（`dev.eeg.coolify.satou-jayo.cc`）
- `main` → push → **Staging 環境**（`staging.eeg.coolify.satou-jayo.cc`）
- `main` → Release 作成 → **Production 環境**（`eeg.coolify.satou-jayo.cc`）

## ルール

- `main`および`develop`への直接 push は禁止
- PR には最低 1 名の承認が必要
- PR の会話はすべて解決してからマージ
