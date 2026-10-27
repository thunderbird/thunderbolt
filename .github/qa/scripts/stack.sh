#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# The QA agent's app stack, in CI and locally: the consumer pair of the root playwright.config.ts (backend with the
# fixed sign-in code, frontend) plus the fake LLM provider, the fake MCP server and the fake Google (also with real
# providers), with a production build served by `vite preview` instead of the dev server.
#
# QA_FRONTEND_PORT, QA_ONBOARDING_PORT, QA_BACKEND_PORT, QA_PROVIDER_PORT, QA_MCP_PORT and QA_GOOGLE_PORT override the
# defaults in .github/qa/ports.json; ports.sh reads both. `serve` refuses a port that is already in use. A stack on
# another backend port keeps its pid files in qa-stack-<backend port>.* instead of qa-stack.*, so two stacks can run
# side by side.
#
#   .github/qa/scripts/stack.sh build <out-dir> [onboarding]  build the frontend (onboarding off unless asked)
#   .github/qa/scripts/stack.sh serve <dist> [<dist>]         serve a build on the frontend port (and one on the
#                                                             onboarding port) until killed
#   .github/qa/scripts/stack.sh serve dev                     Vite dev servers on the working tree (frontend port
#                                                             onboarding off, onboarding port on), backend --watch
#   .github/qa/scripts/stack.sh serve native                  backend and fakes only, for the native apps (no Vite)
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
# job's own user, which later runs model-written specs, holds them. `start dev` with QA_BACKEND_USER runs the backend
# and both Vite servers as that user (the fix job), so code they reload cannot read the fix agent's environment.
# DATABASE_URL + POWERSYNC_URL switch the backend from pglite to an already migrated Postgres with PowerSync.

set -euo pipefail
cd "$(dirname "$0")/../../.."
# Like `bun run`: puts package binaries such as vite on PATH.
export PATH=$PWD/node_modules/.bin:$PATH
# Before the build branch: a build bakes the configured URLs into the app.
. .github/qa/scripts/ports.sh

backend_url=http://localhost:$QA_BACKEND_PORT
fake_google_url=http://127.0.0.1:$QA_GOOGLE_PORT
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
[ "$QA_BACKEND_PORT" = "$(jq .QA_BACKEND_PORT .github/qa/ports.json)" ] || state+="-$QA_BACKEND_PORT"
backend_keys=/home/${QA_BACKEND_USER:-}/keys.env
if [ "$1" = start ]; then
  if [ -n "${QA_BACKEND_USER:-}" ]; then
    sudo useradd --create-home "$QA_BACKEND_USER"
    # Lets that user reach bun and the checkout without listing this user's home.
    sudo chmod o+x "$HOME"
    if [ "${QA_REAL_PROVIDERS:-}" = true ]; then
      sudo install --owner "$QA_BACKEND_USER" --mode 0400 /dev/null "$backend_keys"
      printf 'ANTHROPIC_API_KEY=%s\nTINFOIL_API_KEY=%s\nTINFOIL_ENCLAVE_URL=%s\nEXA_API_KEY=%s\n' \
        "$ANTHROPIC_API_KEY" "$TINFOIL_API_KEY" "$TINFOIL_ENCLAVE_URL" "$EXA_API_KEY" | sudo tee "$backend_keys" > /dev/null
      # Before any server starts: a process's initial environment stays readable to its own user in /proc.
      unset ANTHROPIC_API_KEY TINFOIL_API_KEY TINFOIL_ENCLAVE_URL EXA_API_KEY
    fi
    if [ "${2:-}" = dev ]; then
      # What the dev servers write: Vite's cache, which also stages PowerSync's assets for public/@powersync, and the
      # bundled config, in a dir both users can add files to.
      sudo install -d --owner "$QA_BACKEND_USER" node_modules/.vite public/@powersync
      sudo install -d --mode 1777 node_modules/.vite-temp
    fi
    # sudo makes itself unkillable by this user, so after `lock` only this rule stops the servers: SIGTERM to all of
    # that user's processes, with exactly these arguments, so a spec cannot stop or freeze them with another signal.
    # It sorts after zz-qa-lock, and in sudoers the last matching rule wins.
    sudo sh -c "umask 0337 && echo '$(id -un) ALL=($QA_BACKEND_USER) NOPASSWD: /usr/bin/kill -TERM -1, /bin/kill -TERM -1' \
      > /etc/sudoers.d/zz-qa-lock-stop"
  fi
  # CI's inline stop reads it.
  echo "${QA_BACKEND_USER:-}" > "$state.user"
  "$PWD/.github/qa/scripts/stack.sh" serve "${@:2}" > "$state.log" 2>&1 &
  echo $! > "$state.pid"
  until grep -q "stack ready" "$state.log"; do
    kill -0 $! 2>/dev/null || { cat "$state.log"; exit 1; }
    sleep 1
  done
  exit
fi
if [ "$1" = stop ]; then
  # Returns only once every server is gone, so no process still holds keys.
  pid=$(cat "$state.pid")
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
  # Servers that run as another user outlive the serve script's own kill; the rule `start` installed stops them.
  user=$(cat "$state.user" 2>/dev/null || true)
  if [ -n "$user" ]; then
    if pgrep -u "$user" > /dev/null; then sudo -n -u "$user" /usr/bin/kill -TERM -1; fi
    for _ in $(seq 150); do pgrep -u "$user" > /dev/null || exit 0; sleep 0.2; done
    echo "the servers of $user did not stop" >&2
    exit 1
  fi
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

[ "$1" = serve ] || { echo "usage: $0 build <out-dir> [onboarding] | serve|start <dist> [<dist>] | serve|start dev|native | stop | lock" >&2; exit 2; }
trap 'kill $(jobs -p) 2>/dev/null || true; wait' EXIT

# Vite on macOS binds ::1 only, and Ubuntu's localhost is 127.0.0.1 only, so a port is free when neither answers.
ports=(QA_BACKEND_PORT QA_PROVIDER_PORT QA_MCP_PORT QA_GOOGLE_PORT)
[ "$2" = native ] || ports+=(QA_FRONTEND_PORT)
if [ "$2" = dev ] || [ -n "${3:-}" ]; then ports+=(QA_ONBOARDING_PORT); fi
for name in "${ports[@]}"; do
  port=${!name}
  if (: < "/dev/tcp/127.0.0.1/$port") 2>/dev/null || (: < "/dev/tcp/::1/$port") 2>/dev/null; then
    echo "port $port is in use: stop what listens there or set $name to a free port" >&2
    exit 1
  fi
done

# The last two are the origins of the iOS and Android WebViews.
origins=http://localhost:$QA_FRONTEND_PORT,http://localhost:$QA_ONBOARDING_PORT,tauri://localhost,http://tauri.localhost
backend_env=(
  "PORT=$QA_BACKEND_PORT"
  AUTH_MODE=consumer
  NODE_ENV=test
  WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test
  "BETTER_AUTH_URL=$backend_url"
  BETTER_AUTH_SECRET=e2e-test-secret-at-least-32-characters-long
  "APP_URL=http://localhost:$QA_FRONTEND_PORT"
  "CORS_ORIGINS=$origins"
  "TRUSTED_ORIGINS=$origins"
  RATE_LIMIT_ENABLED=false
  "TEST_PROXY_ALLOWED_HOSTS=127.0.0.1:$QA_MCP_PORT"
  # Any non-empty client makes the app offer Google; these are the fake's own, not secrets.
  GOOGLE_CLIENT_ID=fake-google-client-id
  GOOGLE_CLIENT_SECRET=fake-google-client-secret
  "GOOGLE_BASE_URL=$fake_google_url"
)
if [ "${QA_REAL_PROVIDERS:-}" != true ]; then
  backend_env+=(ANTHROPIC_API_KEY=e2e-fake-provider-key "ANTHROPIC_BASE_URL=http://localhost:$QA_PROVIDER_PORT")
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
bun_run=(bun run)
if [ -n "${QA_BACKEND_USER:-}" ] && [ "${QA_REAL_PROVIDERS:-}" = true ]; then bun_run=(bun "--env-file=$backend_keys" run); fi
# Runs a server, as QA_BACKEND_USER when it is set. sudo resets the environment: the server gets its settings, PATH
# and, for a real-AI backend, the keys file `start` wrote, nothing more.
as_server() {
  if [ -n "${QA_BACKEND_USER:-}" ]; then exec sudo --user "$QA_BACKEND_USER" --set-home -- env "PATH=$PATH" "$@"; fi
  exec "$@"
}

bun -e "import { createFakeProvider } from './e2e/fake-provider'; await createFakeProvider($QA_PROVIDER_PORT)" &
bun -e "import { createFakeMcpServer } from './e2e/fake-mcp-server'; await createFakeMcpServer($QA_MCP_PORT)" &
bun -e "import { createFakeGoogle } from './.github/qa/scripts/fake-google'; createFakeGoogle($QA_GOOGLE_PORT)" &

if [ "$2" = native ]; then
  (cd backend && as_server env "${backend_env[@]}" "${bun_run[@]}" src/index.ts) &
elif [ "$2" = dev ]; then
  # These reload the agent's edits, so in CI they run as another user.
  (cd backend && as_server env "${backend_env[@]}" bun run --watch src/index.ts) &
  (as_server env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=true vite --port "$QA_FRONTEND_PORT" --strictPort) &
  (as_server env "${frontend_env[@]}" VITE_SKIP_ONBOARDING=false vite --port "$QA_ONBOARDING_PORT" --strictPort) &
else
  (cd backend && as_server env "${backend_env[@]}" "${bun_run[@]}" src/index.ts) &
  vite preview --outDir "$2" --port "$QA_FRONTEND_PORT" --strictPort &
  if [ -n "${3:-}" ]; then vite preview --outDir "$3" --port "$QA_ONBOARDING_PORT" --strictPort & fi
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
if [ "$2" != native ]; then wait_for "http://localhost:$QA_FRONTEND_PORT"; fi
if [ "$2" = dev ] || [ -n "${3:-}" ]; then wait_for "http://localhost:$QA_ONBOARDING_PORT"; fi
echo "stack ready"
# Not `wait -n`: bash 3.2, the macOS /bin/bash, lacks it, and there `serve` took the servers down after "ready".
pids=$(jobs -p)
while :; do
  for pid in $pids; do kill -0 "$pid" 2>/dev/null || exit 1; done
  sleep 1
done
