#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at https://mozilla.org/MPL/2.0/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-18080}"
PROVIDER_PORT="${PROVIDER_PORT:-18787}"
BACKEND_URL="http://localhost:${BACKEND_PORT}/v1"
BACKEND_LOG="${TMPDIR:-/tmp}/thunderbolt-native-backend.log"
PROVIDER_LOG="${TMPDIR:-/tmp}/thunderbolt-native-provider.log"
DATABASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/thunderbolt-native-ios-db.XXXXXX")"
BACKEND_PID=""
PROVIDER_PID=""

cleanup() {
  [[ -z "$BACKEND_PID" ]] || kill "$BACKEND_PID" 2>/dev/null || true
  [[ -z "$PROVIDER_PID" ]] || kill "$PROVIDER_PID" 2>/dev/null || true
  [[ -z "$BACKEND_PID" ]] || wait "$BACKEND_PID" 2>/dev/null || true
  [[ -z "$PROVIDER_PID" ]] || wait "$PROVIDER_PID" 2>/dev/null || true
  rm -rf "$DATABASE_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for port in "$BACKEND_PORT" "$PROVIDER_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already in use; stop that service or choose different ports with BACKEND_PORT and PROVIDER_PORT.\n' "$port" >&2
    exit 1
  fi
done

(
  cd "$ROOT_DIR"
  exec env NODE_PATH="$ROOT_DIR/backend/node_modules" PROVIDER_PORT="$PROVIDER_PORT" \
    bun -e 'import { createFakeProvider } from "./e2e/fake-provider.ts"; await createFakeProvider(Number(process.env.PROVIDER_PORT), { performanceDelayMs: 80 })'
) >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!

(
  cd "$ROOT_DIR/backend"
  exec env \
    NODE_ENV=test \
    DATABASE_DRIVER=pglite \
    DATABASE_URL="$DATABASE_DIR" \
    AUTH_MODE=consumer \
    RATE_LIMIT_ENABLED=false \
    PORT="$BACKEND_PORT" \
    HOST=localhost \
    APP_URL="http://localhost:${BACKEND_PORT}" \
    BETTER_AUTH_URL="http://localhost:${BACKEND_PORT}" \
    BETTER_AUTH_SECRET=thunderbolt-native-ios-local-test-secret-32 \
    WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.io \
    ANTHROPIC_API_KEY=thunderbolt-native-ios-fake-provider \
    ANTHROPIC_BASE_URL="http://localhost:${PROVIDER_PORT}" \
    bun src/index.ts
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

wait_for_http() {
  local url="$1"
  local pid="$2"
  local service="$3"
  local log="$4"
  for _ in $(seq 1 60); do
    if curl --silent --output /dev/null --max-time 1 "$url"; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s exited before becoming ready. See %s\n' "$service" "$log" >&2
      return 1
    fi
    sleep 1
  done
  printf 'Timed out waiting for %s at %s. See %s\n' "$service" "$url" "$log" >&2
  return 1
}

wait_for_http "http://localhost:${PROVIDER_PORT}/health" "$PROVIDER_PID" "fake provider" "$PROVIDER_LOG"
wait_for_http "${BACKEND_URL}/health" "$BACKEND_PID" "backend" "$BACKEND_LOG"
printf '\nNative iOS local services are ready:\n  Backend: %s\n  Fake provider: http://localhost:%s\n\nRun the Thunderbolt scheme’s UI tests in Xcode. Press Ctrl+C to stop services and remove their temporary database.\n' "$BACKEND_URL" "$PROVIDER_PORT"
while true; do sleep 60; done
