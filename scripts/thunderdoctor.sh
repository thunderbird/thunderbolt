#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS="${GREEN}✓${NC}"
FAIL="${RED}✗${NC}"
WARN="${YELLOW}!${NC}"

has_critical_failure=false
has_any_failure=false

check() {
  local label="$1"
  local cmd="$2"
  local install_hint="${3:-}"
  local critical="${4:-false}"

  if result=$(eval "$cmd" 2>/dev/null); then
    echo -e "  ${PASS} ${label} ${result:+(${result})}"
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

echo ""
echo "Thunderbolt Doctor"
echo "══════════════════"
echo ""

# --- Tools ---
echo "Tools:"

check "git" \
  "git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: brew install git" \
  true

check "bun" \
  "bun --version" \
  "install with: curl -fsSL https://bun.sh/install | bash" \
  true

check "docker" \
  "docker info >/dev/null 2>&1 && echo \"\$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), running\"" \
  "install Docker Desktop: https://docker.com/products/docker-desktop — make sure daemon is running" \
  true

check "gh" \
  "gh auth status >/dev/null 2>&1 && echo \"\$(gh --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), authenticated\"" \
  "install with: brew install gh && gh auth login"

check "linear" \
  "linear issue list --limit 1 --no-pager >/dev/null 2>&1 && echo 'authenticated'" \
  "install with: brew install linear"

check "cargo" \
  "cargo --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

check "cmake" \
  "cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: brew install cmake"

echo ""

# --- Env files ---
echo "Environment:"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_ROOT/.env" ]; then
  echo -e "  ${PASS} .env exists"
else
  has_any_failure=true
  echo -e "  ${FAIL} .env missing — copy from .env.example: cp .env.example .env"
fi

if [ -f "$PROJECT_ROOT/backend/.env" ]; then
  echo -e "  ${PASS} backend/.env exists"
else
  has_any_failure=true
  echo -e "  ${FAIL} backend/.env missing — copy from backend/.env.example: cp backend/.env.example backend/.env"
fi

echo ""

# --- Summary ---
if [ "$has_critical_failure" = true ]; then
  echo -e "${RED}Some critical tools are missing. Fix them before continuing.${NC}"
  exit 1
elif [ "$has_any_failure" = true ]; then
  echo -e "${YELLOW}Some optional tools are missing. Things may still work, but consider installing them.${NC}"
  exit 0
else
  echo -e "${GREEN}All checks passed!${NC}"
  exit 0
fi
