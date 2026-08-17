#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Boots the PowerSync + Postgres harness (docker-compose) on dedicated ports,
# waits for PowerSync readiness, then runs the E2EE Playwright suite against it.
# Ports default to 5434/8081 (off the dev defaults 5433/8080) so a running dev
# stack is never disturbed. Any extra args are forwarded to `playwright test`
# (e.g. `bash scripts/run-e2ee-powersync.sh migration.spec.ts`).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-thunderbolt-e2ee-${GITHUB_RUN_ID:-local}-$$}"
POSTGRES_PORT="${E2E_POSTGRES_PORT:-5434}"
POWERSYNC_PORT="${E2E_POWERSYNC_PORT:-8081}"
COMPOSE_FILE="$ROOT_DIR/powersync-service/docker-compose.yml"

export COMPOSE_PROJECT_NAME
export POSTGRES_PORT
export POWERSYNC_PORT
export E2E_POSTGRES_PORT="$POSTGRES_PORT"
export E2E_POWERSYNC_PORT="$POWERSYNC_PORT"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

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
bunx playwright test --config=playwright.e2ee.config.ts "$@"
