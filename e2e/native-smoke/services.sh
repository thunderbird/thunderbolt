#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

cd "$(dirname "$0")/../.."
bun -e "import { createFakeProvider } from './e2e/fake-provider.ts'; await createFakeProvider(9878)" &
provider_pid=$!
trap 'kill "$provider_pid" 2>/dev/null || true' EXIT

cd backend
NODE_ENV=test \
DATABASE_DRIVER=pglite \
PORT=8000 \
AUTH_MODE=consumer \
ANTHROPIC_API_KEY=e2e-fake-provider-key \
ANTHROPIC_BASE_URL=http://localhost:9878 \
WAITLIST_AUTO_APPROVE_DOMAINS=thunderbolt.test \
BETTER_AUTH_URL=http://localhost:8000 \
BETTER_AUTH_SECRET=e2e-test-secret-at-least-32-characters-long \
APP_URL=http://localhost:1420 \
CORS_ORIGINS=http://localhost:1420,http://10.0.2.2:1420,tauri://localhost,http://tauri.localhost \
TRUSTED_ORIGINS=http://localhost:1420,http://10.0.2.2:1420,tauri://localhost,http://tauri.localhost \
RATE_LIMIT_ENABLED=false \
  bun src/index.ts
