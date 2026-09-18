#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Boots the PowerSync + Postgres harness (docker-compose) on dedicated ports,
# waits for PowerSync readiness, then runs the E2EE Playwright suite against it.
# Ports default to 5434/8081 (off the dev defaults 5433/8080) so a running dev
# stack is never disturbed. Any extra args are forwarded to `playwright test`
# (e.g. `bash scripts/run-e2ee-powersync.sh migration.spec.ts`, or `--shard=1/3`).
#
# Local iteration speedups (both no-ops on CI, safe to combine):
#   --keep         Leave the Docker harness running after the tests instead of
#                  tearing it down, AND reuse an already-running one. Uses a
#                  stable compose project name so repeated runs share the same
#                  containers — the second run's `up` is a fast no-op, skipping
#                  the ~30-60s boot + readiness wait. Tear down manually when
#                  done (the command is printed on exit).
#   --skip-build   Reuse the existing dist/ instead of a cold `vite build` before
#                  `vite preview` (sets E2EE_SKIP_BUILD for the Playwright config).
#                  A spec-only or backend-only change never touches the frontend
#                  bundle, so the build is pure waste on repeat runs. Requires a
#                  dist/ from a prior full run.
# Env alternatives: E2EE_KEEP=1, E2EE_SKIP_BUILD=1, E2EE_WORKERS=N (parallel files).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Split our own flags out of the args before forwarding the rest to Playwright.
KEEP="${E2EE_KEEP:-0}"
PW_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --skip-build) export E2EE_SKIP_BUILD=1 ;;
    *) PW_ARGS+=("$arg") ;;
  esac
done

# --keep needs a STABLE project name so a later run reuses the same containers;
# without it the default carries $$ (PID), which would orphan the kept stack and
# boot a fresh one every time.
if [[ "$KEEP" == "1" ]]; then
  COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-thunderbolt-e2ee-keep}"
else
  COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-thunderbolt-e2ee-${GITHUB_RUN_ID:-local}-$$}"
fi
POSTGRES_PORT="${E2E_POSTGRES_PORT:-5434}"
POWERSYNC_PORT="${E2E_POWERSYNC_PORT:-8081}"
COMPOSE_FILE="$ROOT_DIR/powersync-service/docker-compose.yml"

export COMPOSE_PROJECT_NAME
export POSTGRES_PORT
export POWERSYNC_PORT
export E2E_POSTGRES_PORT="$POSTGRES_PORT"
export E2E_POWERSYNC_PORT="$POWERSYNC_PORT"

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    echo "[e2ee] --keep: leaving the harness up (postgres:${POSTGRES_PORT}, powersync:${POWERSYNC_PORT})."
    echo "[e2ee] tear down with: docker compose -p ${COMPOSE_PROJECT_NAME} -f ${COMPOSE_FILE} down --volumes --remove-orphans"
    return
  fi
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

# Idempotent: reuses healthy containers (a fast no-op under --keep), or boots them.
docker compose -f "$COMPOSE_FILE" up --detach --wait

bun -e "
const endpoint = 'http://localhost:${POWERSYNC_PORT}/probes/readiness'
const deadline = Date.now() + 60_000
while (Date.now() < deadline) {
  try {
    const response = await fetch(endpoint)
    if (response.ok) process.exit(0)
  } catch {}
  await Bun.sleep(500)
}
throw new Error('PowerSync readiness probe timed out')
"

cd "$ROOT_DIR"
bunx playwright test --config=playwright.e2ee.config.ts ${PW_ARGS[@]+"${PW_ARGS[@]}"}
