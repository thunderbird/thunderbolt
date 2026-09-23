#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Boots a headless OpenClaw ACP agent: one-time onboarding (config + creds +
# device identity) → Gateway → WS↔stdio shim. The shim is the foreground
# process so container lifetime == agent lifetime.
set -euo pipefail

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set (docker run -e OPENROUTER_API_KEY=...)}"
PORT="${PORT:-8790}"
MODEL="${MODEL:-openrouter/auto}"
STATE_DIR="${HOME}/.openclaw"

# One-time headless onboarding. Creates ~/.openclaw with config, the OpenRouter
# credential, and a device identity (the ACP bridge needs an identity to reach
# the gateway). Channels/daemon/UI are skipped — this instance is reachable only
# via Thunderbolt's ACP, which is what makes pause/resume viable later.
if [ ! -f "${STATE_DIR}/openclaw.json" ]; then
  echo "[entrypoint] headless onboarding…"
  openclaw onboard \
    --non-interactive --accept-risk \
    --auth-choice openrouter-api-key --openrouter-api-key "${OPENROUTER_API_KEY}" \
    --skip-channels --skip-daemon --skip-ui --skip-health \
    --workspace "${STATE_DIR}/workspace"
fi

# Default coding model (override with -e MODEL=openrouter/anthropic/claude-sonnet-4.5).
openclaw config set agents.defaults.model.primary "${MODEL}" >/dev/null 2>&1 || true

# Gateway on container loopback, auth off (POC only — real auth is the
# managed-acp bearer at the backend relay, not here).
echo "[entrypoint] starting gateway…"
openclaw gateway run --auth none --bind loopback --force &

# Wait for the gateway port before exposing the shim.
for _ in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/18789) 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 1
done

echo "[entrypoint] gateway up → starting ACP↔WS shim on :${PORT}"
exec bun /opt/shim/acp-ws-shim.ts
