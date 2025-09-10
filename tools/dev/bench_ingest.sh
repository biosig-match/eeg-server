#!/usr/bin/env bash

# Simple ingest throughput benchmark for the processor service.
# - Compares baseline (struct+executemany) vs optimized (NumPy+psycopg3 COPY)
# - Runs dummy_data_sender for a fixed duration and measures rows/s
# - Optionally scales processor replicas

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT_DIR"

# --- Defaults ---
MODES="both"          # baseline|optimized|both
REPLICAS_CSV="1,2,4"  # comma-separated
DURATION=30            # seconds
REBUILD=true
FRESH_DB=true
CAPTURE_STATS=true

usage() {
  cat <<USAGE
Usage: bash tools/dev/bench_ingest.sh [options]
  --mode {baseline|optimized|both}  Which implementation(s) to benchmark (default: both)
  --replicas "1,2,4"                Comma-separated replica counts (default: 1,2,4)
  --duration SECONDS                Send duration for dummy sender (default: 30)
  --no-build                        Do not rebuild images before up
  --no-fresh                        Do not reset DB volumes between runs
  --no-stats                        Do not capture docker stats CPU snapshot
  -h|--help                         Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODES="$2"; shift ;;
    --replicas) REPLICAS_CSV="$2"; shift ;;
    --duration) DURATION="$2"; shift ;;
    --no-build) REBUILD=false ;;
    --no-fresh) FRESH_DB=false ;;
    --no-stats) CAPTURE_STATS=false ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
  shift
end

dcmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[compose] Docker Compose not available" >&2
    return 127
  fi
}

wait_container_healthy() {
  local name="$1"; local timeout="${2:-120}"; local waited=0
  while true; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then
      echo "[wait] $name healthy"
      return 0
    fi
    if [ $waited -ge $timeout ]; then
      echo "[wait] Timeout waiting for $name (last='$status')" >&2
      return 1
    fi
    sleep 2; waited=$((waited+2))
  done
}

curl_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$@"
  else
    python3 - <<'PY'
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=5) as r:
        print(r.read().decode())
except Exception:
    sys.exit(1)
PY
  fi
}

wait_http_ok() {
  local url="$1"; local timeout="${2:-180}"; local waited=0
  while true; do
    if curl_get "$url" >/dev/null 2>&1; then
      echo "[wait] HTTP OK: $url"
      return 0
    fi
    if [ $waited -ge $timeout ]; then
      echo "[wait] Timeout waiting for $url" >&2
      return 1
    fi
    sleep 2; waited=$((waited+2))
  done
}

prepare_py() {
  echo "[py] Preparing .venv and test deps"
  if ! command -v uv >/dev/null 2>&1; then
    echo "[py] 'uv' not found. Install from https://docs.astral.sh/uv/" >&2
    exit 1
  fi
  if [ ! -d .venv ]; then
    uv venv .venv
  fi
  if [ -x ./.venv/bin/python ]; then
    PY=./.venv/bin/python
  elif [ -x ./.venv/Scripts/python.exe ]; then
    PY=.venv/Scripts/python.exe
  else
    echo "[py] Python in .venv not found" >&2
    exit 1
  fi
  bash tools/dev/setup_py_dev_venv.sh >/dev/null
  uv pip install --python "$PY" -r tools/requirements.test.txt >/dev/null
  echo "$PY"
}

db_count() {
  local table="$1"
  docker exec erp_db psql -U "${POSTGRES_USER:-admin}" -d "${POSTGRES_DB:-erp_data}" -t -A -c "SELECT count(*) FROM ${table};" 2>/dev/null | tr -d '\r'
}

snapshot_stats() {
  local outfile="$1"
  local names
  names=$(docker ps --format '{{.Names}} {{.Label "com.docker.compose.service"}}' | awk '$2=="processor"{print $1}')
  if [ -n "$names" ]; then
    docker stats --no-stream $names >"$outfile" || true
  else
    echo "no processor containers" >"$outfile"
  fi
}

bench_one() {
  local mode="$1"; local replicas="$2"; local duration="$3"
  echo "\n===== RUN: mode=${mode} replicas=${replicas} duration=${duration}s ====="

  # Configure flags through override compose file
  case "$mode" in
    baseline)
      export PROCESSOR_USE_NUMPY=0 PROCESSOR_USE_COPY=0 ;;
    optimized)
      export PROCESSOR_USE_NUMPY=1 PROCESSOR_USE_COPY=1 ;;
  esac

  # Fresh DB if requested
  if $FRESH_DB; then
    dcmd down -v >/dev/null 2>&1 || true
  fi

  if $REBUILD; then
    dcmd -f docker-compose.yml -f tools/dev/compose.bench.override.yml up -d --build --scale processor="${replicas}"
  else
    dcmd -f docker-compose.yml -f tools/dev/compose.bench.override.yml up -d --scale processor="${replicas}"
  fi

  # Wait infra
  wait_container_healthy erp_rabbitmq 180 || true
  wait_container_healthy erp_db 180 || true
  : "${NGINX_PORT:=8080}"
  wait_http_ok "http://localhost:${NGINX_PORT}/api/v1/health" 240 || true

  # Prepare sender
  local PY
  PY=$(prepare_py)

  # Baseline counts
  local eeg0 imu0
  eeg0=$(db_count eeg_raw_data || echo 0)
  imu0=$(db_count imu_raw_data || echo 0)

  echo "[bench] Starting sender for ${duration}s"
  EXPERIMENT_DURATION_SEC="$duration" "$PY" tools/dummy_data_sender.py >/dev/null 2>&1 || true

  echo "[bench] Waiting for processor to flush ..."
  sleep 5

  local eeg1 imu1 eegd imud total rows_per_sec
  eeg1=$(db_count eeg_raw_data || echo 0)
  imu1=$(db_count imu_raw_data || echo 0)
  eegd=$((eeg1-eeg0))
  imud=$((imu1-imu0))
  total=$((eegd+imud))
  if [ "$duration" -gt 0 ]; then
    rows_per_sec=$(awk -v n="$eegd" -v d="$duration" 'BEGIN{printf "%.1f", (n+0.0)/d}')
  else
    rows_per_sec="n/a"
  fi

  mkdir -p bench-results
  local tag="${mode}-rep${replicas}-${duration}s"
  if $CAPTURE_STATS; then
    snapshot_stats "bench-results/docker-stats-${tag}.txt"
  fi

  tee "bench-results/summary-${tag}.txt" <<OUT
mode:        ${mode}
replicas:    ${replicas}
duration(s): ${duration}
eeg_rows:    ${eegd}
imu_rows:    ${imud}
total_rows:  ${total}
eeg_rows/s:  ${rows_per_sec}
OUT
}

IFS=',' read -r -a REPLS <<<"$REPLICAS_CSV"

run_modes=()
case "$MODES" in
  both) run_modes=(baseline optimized) ;;
  baseline|optimized) run_modes=($MODES) ;;
  *) echo "Invalid --mode: $MODES" >&2; exit 1 ;;
esac

for m in "${run_modes[@]}"; do
  for r in "${REPLS[@]}"; do
    bench_one "$m" "$r" "$DURATION"
  done
done

echo "\n[bench] Done. See bench-results/ for summaries and docker-stats snapshots."

