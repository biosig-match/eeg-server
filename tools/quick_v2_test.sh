#!/usr/bin/env bash
set -euo pipefail

# quick_v2_test.sh
# - 目的: MQをv2のみで短時間検証し、終わったら完全撤収する
# - 前提: docker, docker compose, python3 が利用可能
# - 任意: Pythonモジュール (requests, websocket-client, zstandard)

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export COLLECTOR_MQ_FORMAT=bin
export PROCESSOR_MQ_FORMAT=v2

echo "[quick-v2-test] Starting stack (v2 only)..."
docker compose up -d --build

cleanup() {
  echo "[quick-v2-test] Cleaning up containers, images and volumes..."
  docker compose down --volumes --remove-orphans --rmi local || true
}
trap cleanup EXIT

# Wait for health of rabbitmq and db
echo "[quick-v2-test] Waiting for rabbitmq/db health..."
for svc in erp_rabbitmq erp_db; do
  for i in {1..60}; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$svc" 2>/dev/null || echo "starting")
    if [[ "$status" == "healthy" ]]; then
      echo "  - $svc: healthy"
      break
    fi
    sleep 2
    if [[ $i -eq 60 ]]; then
      echo "[quick-v2-test] ERROR: $svc not healthy in time" >&2
      exit 1
    fi
  done
done

# Prepare Python env on the fly (optional but convenient)
VENV_DIR="$ROOT_DIR/.venv_quick_test"
if command -v python3 >/dev/null 2>&1; then
  echo "[quick-v2-test] Preparing Python venv..."
  python3 -m venv "$VENV_DIR" || true
  source "$VENV_DIR/bin/activate" || true
  pip -q install --upgrade pip >/dev/null 2>&1 || true
  if [[ -f tools/requirements.test.txt ]]; then
    pip -q install -r tools/requirements.test.txt >/dev/null 2>&1 || true
  fi
fi

echo "[quick-v2-test] Sending short EEG stream via dummy_data_sender.py..."
export EXPERIMENT_DURATION_SEC=8
export SEND_REALTIME=0
python3 tools/dummy_data_sender.py || {
  echo "[quick-v2-test] WARN: dummy sender failed (dependencies missing?). Proceeding to DB check if possible." >&2
}

# Load DB env
source .env >/dev/null 2>&1 || true
PGUSER=${POSTGRES_USER:-admin}
PGDB=${POSTGRES_DB:-erp_data}

echo "[quick-v2-test] Checking DB rows..."
COUNT=$(docker exec -e PGPASSWORD=${POSTGRES_PASSWORD:-password} erp_db \
  psql -U "$PGUSER" -d "$PGDB" -t -c "SELECT COUNT(*) FROM eeg_raw_data;" | tr -d '[:space:]') || COUNT=0

echo "[quick-v2-test] eeg_raw_data count = ${COUNT:-0}"
if [[ "${COUNT:-0}" -gt 0 ]]; then
  echo "[quick-v2-test] OK: v2 path inserted rows into DB."
else
  echo "[quick-v2-test] FAIL: No rows detected in DB." >&2
  exit 2
fi

echo "[quick-v2-test] Done. Stack will be cleaned up now."

