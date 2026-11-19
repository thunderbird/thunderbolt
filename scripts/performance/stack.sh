#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail
cd "$(dirname "$0")/../.."

# A separate band avoids reusing a developer's or e2e runner's app/database.
export QA_FRONTEND_PORT=${QA_FRONTEND_PORT:-1436}
export QA_ONBOARDING_PORT=${QA_ONBOARDING_PORT:-1437}
export QA_BACKEND_PORT=${QA_BACKEND_PORT:-8016}
export QA_PROVIDER_PORT=${QA_PROVIDER_PORT:-9896}
export QA_MCP_PORT=${QA_MCP_PORT:-9897}
export QA_GOOGLE_PORT=${QA_GOOGLE_PORT:-9898}
export QA_REAL_PROVIDERS=false
# The fixed test OTP must never inherit a deployment's public bind address.
export HOST=localhost
# Empty exported values also override Bun's backend/.env loading.
export DATABASE_URL='' POWERSYNC_URL=''
unset QA_BACKEND_USER

case "${1:-}" in
  build|serve) exec bash .github/qa/scripts/stack.sh "$1" "${2:-qa-dist-performance}" "${@:3}" ;;
  *) echo 'Usage: bash scripts/performance/stack.sh build [directory] | serve [directory] [second-directory]' >&2; exit 2 ;;
esac
