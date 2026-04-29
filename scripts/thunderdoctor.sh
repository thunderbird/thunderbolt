#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS="${GREEN}✓${NC}"
FAIL="${RED}✗${NC}"
WARN="${YELLOW}!${NC}"

QUIET=false
if [ "${1:-}" = "--quiet" ] || [ "${1:-}" = "-q" ]; then
  QUIET=true
fi

has_critical_failure=false
has_any_failure=false

check() {
  local label="$1"
  local cmd="$2"
  local install_hint="${3:-}"
  local critical="${4:-false}"

  if result=$(eval "$cmd" 2>/dev/null); then
    if [ "$QUIET" = false ]; then
      echo -e "  ${PASS} ${label} ${result:+(${result})}"
    fi
  else
    has_any_failure=true
    if [ "$critical" = "true" ]; then
      has_critical_failure=true
      echo -e "  ${FAIL} ${label} — ${install_hint}"
    else
      echo -e "  ${WARN} ${label} — ${install_hint}"
    fi
  fi
}

if [ "$QUIET" = false ]; then
  echo ""
  echo "Thunderbolt Doctor"
  echo "══════════════════"
  echo ""
  echo "Tools:"
fi

check "bun" \
  "bun --version" \
  "install with: curl -fsSL https://bun.sh/install | bash" \
  true

check "cargo" \
  "cargo --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

check "cmake" \
  "cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: brew install cmake"

check "container runtime (docker or podman)" \
  "if command -v podman-compose > /dev/null 2>&1 && podman info >/dev/null 2>&1; then echo \"podman \$(podman --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), running\"; elif docker info >/dev/null 2>&1; then echo \"docker \$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), running\"; else exit 1; fi" \
  "install Docker Desktop (https://docker.com/products/docker-desktop) or Podman (https://podman.io) — make sure daemon is running" \
  true

check "gh" \
  "ver=\$(gh --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) && if gh auth status >/dev/null 2>&1; then echo \"\$ver, logged in\"; else echo \"\$ver, logged out\"; fi" \
  "install with: brew install gh && gh auth login"

check "git" \
  "git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: brew install git" \
  true

check "linear" \
  "ver=\$(linear --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') && if linear auth whoami >/dev/null 2>&1; then echo \"\$ver, logged in\"; else echo \"\$ver, logged out\"; fi" \
  "install with: brew install schpet/tap/linear && linear auth login"

check "render" \
  "ver=\$(render --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') && if render whoami -o json >/dev/null 2>&1; then echo \"\$ver, logged in\"; else echo \"\$ver, logged out\"; fi" \
  "install with: brew install render && render login"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ "$QUIET" = false ]; then
  echo ""
  echo "Environment:"
fi

if [ -L "$PROJECT_ROOT/.claude/agents/thunderbot.md" ]; then
  if [ "$QUIET" = false ]; then
    echo -e "  ${PASS} .claude/agents/thunderbot.md symlink"
  fi
else
  has_any_failure=true
  echo -e "  ${WARN} .claude/agents/thunderbot.md symlink missing — run: make setup-symlinks"
fi

if [ -L "$PROJECT_ROOT/.claude/commands/thunderbot.md" ]; then
  if [ "$QUIET" = false ]; then
    echo -e "  ${PASS} .claude/commands/thunderbot.md symlink"
  fi
else
  has_any_failure=true
  echo -e "  ${WARN} .claude/commands/thunderbot.md symlink missing — run: make setup-symlinks"
fi

if [ -f "$PROJECT_ROOT/.env" ]; then
  if [ "$QUIET" = false ]; then
    echo -e "  ${PASS} .env exists"
  fi
else
  has_any_failure=true
  echo -e "  ${FAIL} .env missing — copy from .env.example: cp .env.example .env"
fi

if [ -f "$PROJECT_ROOT/backend/.env" ]; then
  if [ "$QUIET" = false ]; then
    echo -e "  ${PASS} backend/.env exists"
  fi
else
  has_any_failure=true
  echo -e "  ${FAIL} backend/.env missing — copy from backend/.env.example: cp backend/.env.example backend/.env"
fi

if [ "$QUIET" = false ]; then
  echo ""
fi

# --- Summary ---
if [ "$has_critical_failure" = true ]; then
  echo -e "${RED}Some critical tools are missing. Fix them before continuing.${NC}"
  exit 1
elif [ "$has_any_failure" = true ]; then
  echo -e "${YELLOW}Some optional tools are missing. Things may still work, but consider installing them.${NC}"
  exit 0
else
  if [ "$QUIET" = false ]; then
    echo -e "${GREEN}All checks passed!${NC}"
  fi
  exit 0
fi
