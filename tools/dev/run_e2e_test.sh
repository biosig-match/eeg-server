#!/usr/bin/env bash

# If invoked with `sh` (dash), re-exec with bash to support pipefail/arrays, etc.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# End-to-end test runner for README section.
# - Ensures the editor .venv exists (reuses setup script)
# - Installs test-only deps into .venv
# - Runs tools/dummy_data_sender.py with that interpreter
# - (optional) Brings up docker-compose stack and waits for health

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "[test] 'uv' not found. Install from https://docs.astral.sh/uv/ and re-run." >&2
  exit 1
fi

# --- CLI flags ---
COMPOSE_UP=false
COMPOSE_BUILD=true
while [ $# -gt 0 ]; do
  case "$1" in
    --compose|--up)
      COMPOSE_UP=true
      ;;
    --no-build)
      COMPOSE_BUILD=false
      ;;
    -h|--help)
      echo "Usage: bash tools/dev/run_e2e_test.sh [--compose] [--no-build]";
      echo "  --compose   Bring up docker-compose stack and wait for health.";
      echo "  --no-build  When used with --compose, skip --build.";
      exit 0
      ;;
  esac
  shift
done

# --- Helpers ---
dcmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[compose] Docker Compose is not available. Install Docker Desktop or docker-compose." >&2
    return 127
  fi
}

wait_container_healthy() {
  local name="$1"; local timeout="${2:-60}"; local waited=0
  while true; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || true)
    if [ "$status" = "healthy" ]; then
      echo "[wait] $name is healthy"
      return 0
    fi
    if [ $waited -ge $timeout ]; then
      echo "[wait] Timeout waiting for $name to be healthy (last='$status')" >&2
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
except Exception as e:
    sys.exit(1)
PY
  fi
}

wait_http_ok() {
  local url="$1"; local timeout="${2:-60}"; local waited=0
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

# --- Optionally bring up the stack and wait for health ---
if $COMPOSE_UP; then
  echo "[compose] Starting stack (this may take a while)"
  if $COMPOSE_BUILD; then
    dcmd up -d --build || { echo "[compose] Failed to start stack" >&2; exit 1; }
  else
    dcmd up -d || { echo "[compose] Failed to start stack" >&2; exit 1; }
  fi

  # Export env for port values
  if [ -f .env ]; then
    set -a; . ./.env; set +a
  fi

  # Wait for core infra health (only services that define healthchecks)
  wait_container_healthy erp_rabbitmq 120 || true
  wait_container_healthy erp_db 120 || true

  # Wait for ingress health endpoint to be served via collector
  : "${NGINX_PORT:=8080}"
  wait_http_ok "http://localhost:${NGINX_PORT}/api/v1/health" 180 || {
    echo "[compose] Ingress/collector health endpoint not responding. Proceeding anyway." >&2
  }
fi

echo "[test] Preparing editor .venv (if missing)"
# Avoid uv's interactive prompt by creating only when absent
if [ ! -d .venv ]; then
  echo "[test] .venv not found. Creating with uv..."
  uv venv .venv
else
  echo "[test] Reusing existing .venv"
fi

# Ensure base service deps + dev tools are present (idempotent)
bash tools/dev/setup_py_dev_venv.sh

echo "[test] Installing test requirements into .venv"
# Target the venv interpreter explicitly to avoid ambiguity
if [ -x ./.venv/bin/python ]; then
  PY=./.venv/bin/python
elif [ -x ./.venv/Scripts/python.exe ]; then
  PY=.venv/Scripts/python.exe
else
  echo "[test] Python in .venv not found." >&2
  exit 1
fi

uv pip install --python "$PY" -r tools/requirements.test.txt

echo "[test] Running dummy_data_sender with $PY"
"$PY" tools/dummy_data_sender.py
