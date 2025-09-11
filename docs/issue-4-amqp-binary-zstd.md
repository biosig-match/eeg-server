# Issue #4: EEG フレームの JSON を MQ から撤廃しバイナリ化（AMQP: application/octet-stream + zstd）

このドキュメントは最終仕様と移行結果のメモです。詳細な要件は GitHub Issue #4 を参照してください。

## 概要（最終仕様）
- Collector→RabbitMQ の EEG フレームを、JSON(Base64) ではなく「zstd 圧縮済みバイナリ」で送出。
- メタデータは AMQP properties/headers に格納。
- Routing key は `eeg.raw` に統一（v2 正式）。

## 現在の仕様（フラグ撤廃後）
- フラグ（`COLLECTOR_MQ_FORMAT`/`PROCESSOR_MQ_FORMAT`）は撤廃済み。常に v2（バイナリ）で動作。
- Routing key は `eeg.raw` 固定。

## Collector 実装の要点（`collector/src/server.ts`）
- WebSocket 受信
  - JSON入力: `payload`(Base64, zstd圧縮済) をデコードし、バイナリとして publish。
  - バイナリ入力: 受信バイト列をそのまま publish（zstd 圧縮済み想定）。
- Publish 先/プロパティ
  - Exchange: `raw_data_exchange`
  - Routing key: `eeg.raw`
  - Properties: `contentType=application/octet-stream`, `contentEncoding=zstd`, `persistent=true`, `timestamp`（epoch 秒）
  - Headers: `device_id`, `experiment_id`, `epoch_id`, `server_received_timestamp`, `schema_version=v2-bin`

## Processor 実装の要点（`processor/src/main.py`）
- `routing_key=eeg.raw` を購読し、`application/octet-stream` + `zstd` を前提に伸張・パース。
- メタデータは AMQP headers から取得（`device_id`/`server_received_timestamp` 等）。
- v1(JSON) 経路は削除済み。

## ロールアウト結果
- 段階移行を経て、v2（`eeg.raw` バイナリ）に統一済み。
- 検証は Compose + `tools/dummy_data_sender.py` により手動E2Eで実施（起動→送信→DB確認→BIDSエクスポート→撤収）。

## TODO
- [ ] README 図と説明の v2 前提化（必要に応じて）
