# Issue #4: EEG フレームの JSON を MQ から撤廃しバイナリ化（AMQP: application/octet-stream + zstd）

このドキュメントは移行計画と実装方針のメモです。詳細な要件は GitHub Issue #4 を参照してください。

## 概要
- Collector→RabbitMQのEEGフレームを、JSON(Base64)から「zstd圧縮済みバイナリ」に移行。
- メタデータは AMQP プロパティ/ヘッダに格納。
- 互換期間は v1(JSON) / v2(バイナリ) を並行運用。

## 追加した環境変数（.env）
- `COLLECTOR_MQ_FORMAT=json|bin|both`（初期値: `json`）
  - `json`: 既存の `eeg.raw` へ JSON をそのまま publish
  - `bin`: 受信JSONの `payload` をBase64デコードして `eeg.raw.bin` へバイナリ publish
  - `both`: 上記両方を publish（検証用）
- `PROCESSOR_MQ_FORMAT=v1|v2|both`（初期値: `v1`）
  - `v1`: `eeg.raw` のJSONのみ処理
  - `v2`: `eeg.raw.bin` のバイナリのみ処理
  - `both`: 両方処理（重複計上に注意）

## Collector 実装の要点（`collector/src/server.ts`）
- WebSocketで受信したJSONメッセージから `payload` をBase64デコードし、AMQPへ以下のプロパティで publish：
  - `contentType=application/octet-stream`, `contentEncoding=zstd`, `persistent=true`
  - `timestamp`（server epoch 秒）
  - `headers`: `device_id`, `experiment_id`, `epoch_id`, `server_received_timestamp`, `schema_version=v2-bin`
- 既定は後方互換のためJSONのみ（`COLLECTOR_MQ_FORMAT=json`）。

## Processor 実装の要点（`processor/src/main.py`）
- 既存の v1(JSON) パスを維持。
- v2(バイナリ) パスを追加：`routing_key=eeg.raw.bin` を受信したら `body` をzstd伸張し、ヘッダから `device_id` / `server_received_timestamp` を取得。

## ロールアウト（最小構成）
1. Phase 0: `PROCESSOR_MQ_FORMAT=v1` のまま、v2受信コードを追加（完了）。
2. Phase 1: `COLLECTOR_MQ_FORMAT=bin` に切替し、`eeg.raw.bin` を並行で publish。
3. Phase 2: `PROCESSOR_MQ_FORMAT=v2` に切替し、安定後に v1 停止。

## TODO
- [ ] Collector: バイナリWS入力（メタ付与）対応
- [ ] E2E/負荷試験スクリプト更新（bin/bothパスの検証）
- [ ] READMEの図と説明更新

