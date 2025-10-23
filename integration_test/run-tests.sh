#!/usr/bin/env bash
#
# Orchestrates the full integration-test docker-compose stack, ensuring we start
# from a clean slate, build fresh images, run the tests, and tear everything
# down again regardless of success or failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_FILES=(-f "${PROJECT_ROOT}/docker-compose.yml")
if [[ -f "${PROJECT_ROOT}/docker-compose.development.yml" ]]; then
  COMPOSE_FILES+=(-f "${PROJECT_ROOT}/docker-compose.development.yml")
elif [[ -f "${PROJECT_ROOT}/docker-compose.override.yml" ]]; then
  COMPOSE_FILES+=(-f "${PROJECT_ROOT}/docker-compose.override.yml")
fi
COMPOSE_FILES+=(-f "${PROJECT_ROOT}/docker-compose.test.yml")

export COMPOSE_PROFILES="${COMPOSE_PROFILES:-integration-tests}"

cleanup() {
  echo "🧹 Cleaning up test environment..."
  docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🧼 Removing any previous integration-test stack..."
docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true

BUILD_CMD=(docker compose "${COMPOSE_FILES[@]}" build)
if [[ "${INTEGRATION_TEST_NO_CACHE:-}" == "1" ]]; then
  echo "🔨 Building services without cache..."
  BUILD_CMD+=(--no-cache)
else
  echo "🔨 Building services (using Docker cache)..."
fi
"${BUILD_CMD[@]}"

echo "🚀 Starting services and running integration tests..."
set +e
docker compose "${COMPOSE_FILES[@]}" up --abort-on-container-exit integration-test
EXIT_CODE=$?
set -e

echo "🧽 Pruning dangling Docker images and networks (build cache preserved)..."
docker image prune -f >/dev/null
docker network prune -f >/dev/null

if [[ ${EXIT_CODE} -eq 0 ]]; then
  echo "✅ Integration tests passed"
else
  echo "❌ Integration tests failed"
fi

exit "${EXIT_CODE}"
