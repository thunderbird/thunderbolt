#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# The QA agent's app stack, in CI and locally: the consumer pair of the root playwright.config.ts (backend on 8005
# with the fixed sign-in code, frontend on 1424) plus the fake LLM provider (9878), the fake MCP server (9879) and the
# fake Google (9880, also with real providers), with a production build served by `vite preview` instead of the dev
# server.
#
#   .github/qa/scripts/stack.sh build <out-dir> [onboarding]  build the frontend (onboarding off unless asked)
#   .github/qa/scripts/stack.sh serve <dist> [<dist>]         serve a build on 1424 (and one on 1425) until killed
#   .github/qa/scripts/stack.sh serve dev                     Vite dev server on the working tree, backend --watch
#   .github/qa/scripts/stack.sh start <serve args> / stop     for CI steps: serve in the background, return once
#                                                             ready; the pids go to $RUNNER_TEMP/qa-stack.pid and
#                                                             qa-stack.pids
#   .github/qa/scripts/stack.sh lock                          for CI: take root away from this user for the rest
#                                                             of the job
#
# `serve` prints "stack ready" once every server answers, and exits when any of them does.
# QA_REAL_PROVIDERS=true hands the backend ANTHROPIC_API_KEY, TINFOIL_API_KEY, TINFOIL_ENCLAVE_URL and EXA_API_KEY
# from the environment instead of the fake provider. With QA_BACKEND_USER=<name> as well (CI), `start` creates that
# OS user and moves the keys into a file only it can read, and the backend runs as that user, so no process of the
# job's own user, which later runs model-written specs, holds them. DATABASE_URL + POWERSYNC_URL switch the backend
# from pglite to an already migrated Postgres with PowerSync, as in nightly.yml.

set -euo pipefail
cd "$(dirname "$0")/../../.."
# Like `bun run`: vite.config.ts calls package binaries such as powersync-web.
export PATH=$PWD/node_modules/.bin:$PATH

backend_url=http://localhost:8005
fake_google_url=http://127.0.0.1:9880
frontend_env=(
  VITE_AUTH_MODE=thunderbolt
  VITE_AUTH_ENABLE_ANONYMOUS=false
  VITE_BYPASS_WAITLIST=false
  "VITE_THUNDERBOLT_CLOUD_URL=$backend_url/v1"
  "VITE_GOOGLE_BASE_URL=$fake_google_url"
)

if [ "$1" = build ]; then
  skip_onboarding=true
  [ "${3:-}" = onboarding ] && skip_onboarding=false
  env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=$skip_onboarding vite build --outDir "$2"
  exit
fi

state=${RUNNER_TEMP:-/tmp}/qa-stack
backend_keys=/home/${QA_BACKEND_USER:-}/keys.env
if [ "$1" = start ]; then
  if [ -n "${QA_BACKEND_USER:-}" ]; then
    sudo useradd --create-home "$QA_BACKEND_USER"
    # Lets that user reach bun and the checkout without listing this user's home.
    sudo chmod o+x "$HOME"
    sudo install --owner "$QA_BACKEND_USER" --mode 0400 /dev/null "$backend_keys"
    printf 'ANTHROPIC_API_KEY=%s\nTINFOIL_API_KEY=%s\nTINFOIL_ENCLAVE_URL=%s\nEXA_API_KEY=%s\n' \
      "$ANTHROPIC_API_KEY" "$TINFOIL_API_KEY" "$TINFOIL_ENCLAVE_URL" "$EXA_API_KEY" | sudo tee "$backend_keys" > /dev/null
    # Before any server starts: a process's initial environment stays readable to its own user in /proc.
    unset ANTHROPIC_API_KEY TINFOIL_API_KEY TINFOIL_ENCLAVE_URL EXA_API_KEY
  fi
  "$PWD/.github/qa/scripts/stack.sh" serve "${@:2}" > "$state.log" 2>&1 &
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
if [ "$1" = lock ]; then
  # Root could read the backend's keys, and the runner's memory, which holds every secret the job references. The
  # docker group is root in all but name, and in sudoers the last matching rule wins.
  sudo rm -f /var/run/docker.sock
  sudo sh -c "umask 0337 && echo '$(id -un) ALL=(ALL:ALL) NOPASSWD: !ALL' > /etc/sudoers.d/zz-qa-lock"
  if sudo -n true 2>/dev/null; then echo "sudo still works" >&2; exit 1; fi
  # Yama 1 or more: a process may read the memory of its own descendants only, not the runner's. No Yama is like 0.
  if [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" -lt 1 ]; then
    echo "kernel.yama.ptrace_scope is 0 or missing" >&2
    exit 1
  fi
  exit
fi

[ "$1" = serve ] || { echo "usage: $0 build <out-dir> [onboarding] | serve|start <dist> [<dist>] | serve|start dev | stop | lock" >&2; exit 2; }
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
  # Any non-empty client makes the app offer Google; these are the fake's own, not secrets.
  GOOGLE_CLIENT_ID=fake-google-client-id
  GOOGLE_CLIENT_SECRET=fake-google-client-secret
  "GOOGLE_BASE_URL=$fake_google_url"
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
backend=(env "${backend_env[@]}" bun run src/index.ts)
if [ -n "${QA_BACKEND_USER:-}" ]; then
  # sudo resets the environment: the backend gets its settings, PATH and the keys file `start` wrote, nothing more.
  backend=(sudo --user "$QA_BACKEND_USER" --set-home -- env "${backend_env[@]}" "PATH=$PATH"
    bun "--env-file=$backend_keys" run src/index.ts)
fi

bun -e "import { createFakeProvider } from './e2e/fake-provider'; await createFakeProvider(9878)" &
bun -e "import { createFakeMcpServer } from './e2e/fake-mcp-server'; await createFakeMcpServer(9879)" &
bun -e "import { createFakeGoogle } from './.github/qa/scripts/fake-google'; createFakeGoogle(9880)" &

if [ "$2" = dev ]; then
  (cd backend && exec env "${backend_env[@]}" bun run --watch src/index.ts) &
  env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=true vite --port 1424 --strictPort &
else
  (cd backend && exec "${backend[@]}") &
  vite preview --outDir "$2" --port 1424 --strictPort &
  if [ -n "${3:-}" ]; then vite preview --outDir "$3" --port 1425 --strictPort & fi
fi
# Next to start's pid file, outside the checkout: CI kills these inline, without running this script again.
jobs -p > "$state.pids"

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
