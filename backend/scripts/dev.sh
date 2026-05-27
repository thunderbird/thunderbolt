#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Run the backend dev server.
# If OP_ENVIRONMENT_ID is set (in .env or the shell), inject secrets via `op run`.
# Otherwise, fall back to Bun's built-in .env loader.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ -n "${OP_ENVIRONMENT_ID:-}" ]; then
  exec op run --environment="$OP_ENVIRONMENT_ID" -- bun run --watch src/index.ts
fi

exec bun run --watch src/index.ts
