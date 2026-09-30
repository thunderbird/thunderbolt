#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# The QA agent's app stack, in CI and locally: the consumer pair of playwright.config.ts (backend on 8005 with the
# fixed sign-in code, frontend on 1424) plus the fake LLM provider (9878) and the fake MCP server (9879), with a
# production build served by `vite preview` instead of the dev server.
#
#   scripts/qa/stack.sh build <out-dir> [onboarding]   build the frontend for this stack (onboarding off unless asked)
#   scripts/qa/stack.sh serve <dist> [<dist>]          serve a build on 1424 (and a second one on 1425) until killed
#   scripts/qa/stack.sh serve dev                      Vite dev server on the working tree, backend with --watch
#   scripts/qa/stack.sh start <serve args> / stop      for CI steps: serve in the background, return once ready
#
# `serve` prints "stack ready" once every server answers, and exits when any of them does.
# QA_REAL_PROVIDERS=true hands the backend ANTHROPIC_API_KEY, TINFOIL_API_KEY, TINFOIL_ENCLAVE_URL and EXA_API_KEY
# from the environment instead of the fake provider. DATABASE_URL + POWERSYNC_URL switch the backend from pglite to
# an already migrated Postgres with PowerSync, as in nightly.yml.

set -euo pipefail
cd "$(dirname "$0")/../.."
# Like `bun run`: vite.config.ts calls package binaries such as powersync-web.
export PATH=$PWD/node_modules/.bin:$PATH

backend_url=http://localhost:8005
frontend_env=(
  VITE_AUTH_MODE=thunderbolt
  VITE_AUTH_ENABLE_ANONYMOUS=false
  VITE_BYPASS_WAITLIST=false
  "VITE_THUNDERBOLT_CLOUD_URL=$backend_url/v1"
)

if [ "$1" = build ]; then
  skip_onboarding=true
  [ "${3:-}" = onboarding ] && skip_onboarding=false
  env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=$skip_onboarding vite build --outDir "$2"
  exit
fi

state=${RUNNER_TEMP:-/tmp}/qa-stack
if [ "$1" = start ]; then
  "$PWD/scripts/qa/stack.sh" serve "${@:2}" > "$state.log" 2>&1 &
  echo $! > "$state.pid"
  until grep -q "stack ready" "$state.log"; do
    kill -0 $! 2>/dev/null || { cat "$state.log"; exit 1; }
    sleep 1
  done
  exit
fi
if [ "$1" = stop ]; then
  # Returns only once every server is gone: CI stops the stack so that no process holds keys any more.
  pid=$(cat "$state.pid")
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
  exit
fi

[ "$1" = serve ] || { echo "usage: $0 build <out-dir> [onboarding] | serve|start <dist> [<dist>] | serve|start dev | stop" >&2; exit 2; }
trap 'kill $(jobs -p) 2>/dev/null || true; wait' EXIT

origins=http://localhost:1424,http://localhost:1425
backend_env=(
  PORT=8005
  AUTH_MODE=consumer
  NODE_ENV=test
  WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test
  "BETTER_AUTH_URL=$backend_url"
  BETTER_AUTH_SECRET=e2e-test-secret-at-least-32-characters-long
  APP_URL=http://localhost:1424
  "CORS_ORIGINS=$origins"
  "TRUSTED_ORIGINS=$origins"
  RATE_LIMIT_ENABLED=false
  TEST_PROXY_ALLOWED_HOSTS=127.0.0.1:9879
)
if [ "${QA_REAL_PROVIDERS:-}" != true ]; then
  backend_env+=(ANTHROPIC_API_KEY=e2e-fake-provider-key ANTHROPIC_BASE_URL=http://localhost:9878)
fi
if [ -n "${DATABASE_URL:-}" ]; then
  backend_env+=(
    DATABASE_DRIVER=postgres
    POWERSYNC_JWT_SECRET=enterprise-thunderbolt-powersync-jwt-default-secret
    POWERSYNC_JWT_KID=enterprise-powersync
    SKIP_MIGRATIONS=true
  )
else
  backend_env+=(DATABASE_DRIVER=pglite)
fi

bun -e "import { createFakeProvider } from './e2e/fake-provider'; await createFakeProvider(9878)" &
bun -e "import { createFakeMcpServer } from './e2e/fake-mcp-server'; await createFakeMcpServer(9879)" &

if [ "$2" = dev ]; then
  (cd backend && exec env "${backend_env[@]}" bun run --watch src/index.ts) &
  env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=true vite --port 1424 --strictPort &
else
  (cd backend && exec env "${backend_env[@]}" bun run src/index.ts) &
  vite preview --outDir "$2" --port 1424 --strictPort &
  if [ -n "${3:-}" ]; then vite preview --outDir "$3" --port 1425 --strictPort & fi
fi

wait_for() {
  for _ in $(seq 120); do
    curl --silent --fail --output /dev/null "$1" && return
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  exit 1
}
wait_for $backend_url/v1/health
wait_for http://localhost:1424
if [ -n "${3:-}" ]; then wait_for http://localhost:1425; fi
echo "stack ready"
wait -n
