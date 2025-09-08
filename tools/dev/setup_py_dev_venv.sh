#!/usr/bin/env bash

# If invoked with `sh` (dash), re-exec with bash to support pipefail/arrays, etc.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# Create/update a root .venv for editor/Pylance only and
# install all Python service dependencies using uv.
# This does NOT affect Docker runtime; it's just for local IDE analysis.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "[setup] 'uv' not found. Install from https://docs.astral.sh/uv/ then re-run." >&2
  exit 1
fi

echo "[setup] Creating .venv with uv if missing"
if [ ! -d .venv ]; then
  uv venv .venv
else
  echo "[setup] Reusing existing .venv"
fi

echo "[setup] Installing service requirements into .venv (editor-only)"
if [ -x ./.venv/bin/python ]; then
  PY=./.venv/bin/python
elif [ -x ./.venv/Scripts/python.exe ]; then
  PY=.venv/Scripts/python.exe
else
  echo "[setup] Python in .venv not found." >&2
  exit 1
fi

uv pip install --python "$PY" \
  -r bids_manager/requirements.txt \
  -r processor/requirements.txt \
  -r realtime_analyzer/requirements.txt

echo "[setup] Installing common dev tools"
uv pip install --python "$PY" -U ruff pyright

echo
echo "[done] Editor venv ready at .venv"
echo "       In VSCode, ensure the interpreter is set to .venv/bin/python."
