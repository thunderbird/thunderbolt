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

check "sccache" \
  "sccache --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "install with: cargo install sccache (speeds up Rust rebuilds; configured in src-tauri/.cargo/config.toml)"

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

# Linux desktop builds need GTK/WebKit dev libraries for Tauri.
# Probe for them via pkg-config (the package names match what tauri's bundler links against).
if [ "$(uname -s)" = "Linux" ]; then
  check "Tauri Linux deps (webkit2gtk-4.1)" \
    "pkg-config --exists webkit2gtk-4.1 && echo present" \
    "install with: sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev (or equivalent for your distro: https://v2.tauri.app/start/prerequisites/#linux)"
fi

# Mobile dev prerequisites — checked but flagged optional (only needed for `tauri:dev:ios` / `tauri:dev:android`).
if [ "$(uname -s)" = "Darwin" ]; then
  check "Xcode command-line tools (for iOS dev)" \
    "xcode-select -p | grep -q . && xcrun --version | head -1" \
    "install with: xcode-select --install (then accept the license: sudo xcodebuild -license)"

  check "iOS Simulator (at least one device)" \
    "xcrun simctl list devices available 2>/dev/null | grep -E 'iPhone|iPad' | head -1" \
    "open Xcode → Settings → Components and download a simulator runtime"
fi

check "ANDROID_HOME (for Android dev)" \
  "[ -n \"$ANDROID_HOME\" ] && [ -d \"$ANDROID_HOME\" ] && echo \"$ANDROID_HOME\"" \
  "install Android Studio (https://developer.android.com/studio), then: export ANDROID_HOME=\$HOME/Library/Android/sdk (macOS) or wherever the SDK landed"

check "adb (Android Debug Bridge)" \
  "adb --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'" \
  "ships with Android SDK; ensure \$ANDROID_HOME/platform-tools is on PATH"

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

# Validate env files: detect duplicate keys, fill in missing BETTER_AUTH_SECRET.
# Duplicate keys silently win first-wins under dotenv, masking edits — surface them as warnings.
validate_env_file() {
  local env_path="$1"
  [ -f "$env_path" ] || return 0
  local rel="${env_path#$PROJECT_ROOT/}"

  local dupes
  dupes=$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$env_path" | sed -E 's/=.*//' | sort | uniq -d || true)
  if [ -n "$dupes" ]; then
    has_any_failure=true
    local first_dupe
    first_dupe=$(echo "$dupes" | head -1)
    echo -e "  ${WARN} ${rel} has duplicate keys (${first_dupe}…) — dotenv keeps the first; later edits are silently ignored"
  elif [ "$QUIET" = false ]; then
    echo -e "  ${PASS} ${rel} has no duplicate keys"
  fi
}

validate_env_file "$PROJECT_ROOT/.env"
validate_env_file "$PROJECT_ROOT/backend/.env"

# BETTER_AUTH_SECRET: required, must be a real value. If missing or placeholder, offer to generate.
# Auto-write only happens when stdout is a TTY (interactive `make doctor`) or when
# THUNDERDOCTOR_AUTOFIX=true is explicitly opted-in (CI / scripted use). Otherwise we warn —
# silently rewriting backend/.env in someone's editor save loop or CI script is hostile.
PLACEHOLDER_SECRET="better-auth-secret-change-in-production-12345678901234567890"
if [ -f "$PROJECT_ROOT/backend/.env" ]; then
  current_secret=$(grep -E '^BETTER_AUTH_SECRET=' "$PROJECT_ROOT/backend/.env" | head -1 | sed -E 's/^BETTER_AUTH_SECRET=//; s/^"(.*)"$/\1/' || true)
  # Better Auth warns when secret length × log2(unique chars) < 120 bits. A 32-char base64
  # secret clears the bar; anything shorter than 32 is regenerated to avoid the warning.
  if [ -z "$current_secret" ] || [ "$current_secret" = "$PLACEHOLDER_SECRET" ] || [ ${#current_secret} -lt 32 ]; then
    if [ ! -t 1 ] && [ "${THUNDERDOCTOR_AUTOFIX:-}" != "true" ]; then
      has_critical_failure=true
      echo -e "  ${FAIL} BETTER_AUTH_SECRET is empty/placeholder/short — won't auto-fix from a non-interactive shell. Run \`make doctor\` from a terminal, or set THUNDERDOCTOR_AUTOFIX=true to opt in."
    elif command -v openssl >/dev/null 2>&1; then
      new_secret=$(openssl rand -base64 32)
      echo -e "  ${YELLOW}→${NC} Writing a fresh BETTER_AUTH_SECRET to backend/.env..."
      # Pass the new secret via the environment (ENVIRON[]) instead of `awk -v` to avoid
      # awk's backslash-escape interpretation. base64 output doesn't include backslashes
      # today, but this keeps the rewrite safe if we ever swap the generator.
      tmp=$(mktemp)
      NEW_SECRET="$new_secret" awk '
        BEGIN { val = ENVIRON["NEW_SECRET"]; replaced = 0 }
        /^BETTER_AUTH_SECRET=/ { print "BETTER_AUTH_SECRET=" val; replaced = 1; next }
        { print }
        END { if (!replaced) print "BETTER_AUTH_SECRET=" val }
      ' "$PROJECT_ROOT/backend/.env" > "$tmp" && mv "$tmp" "$PROJECT_ROOT/backend/.env"
      echo -e "  ${PASS} BETTER_AUTH_SECRET generated and written to backend/.env"
    else
      has_critical_failure=true
      echo -e "  ${FAIL} BETTER_AUTH_SECRET is empty/placeholder and openssl is not installed — set it manually with a 32+ char value"
    fi
  elif [ "$QUIET" = false ]; then
    echo -e "  ${PASS} BETTER_AUTH_SECRET is set"
  fi

  # POWERSYNC_URL is required when DATABASE_DRIVER=postgres; the backend silently 503s without it.
  driver=$(grep -E '^DATABASE_DRIVER=' "$PROJECT_ROOT/backend/.env" | head -1 | sed -E 's/^DATABASE_DRIVER=//; s/^"(.*)"$/\1/' || true)
  if [ "$driver" = "postgres" ]; then
    powersync_url=$(grep -E '^POWERSYNC_URL=' "$PROJECT_ROOT/backend/.env" | head -1 | sed -E 's/^POWERSYNC_URL=//; s/^"(.*)"$/\1/' || true)
    if [ -z "$powersync_url" ]; then
      has_any_failure=true
      echo -e "  ${WARN} backend/.env: DATABASE_DRIVER=postgres but POWERSYNC_URL is not set — sync will fail. Add: POWERSYNC_URL=http://localhost:8080"
    elif [ "$QUIET" = false ]; then
      echo -e "  ${PASS} POWERSYNC_URL is set (${powersync_url})"
    fi
  fi

  # CORS_ALLOW_HEADERS: catch drift between an old local .env and the canonical example list.
  # When backend/.env.example gains a new header (e.g. X-Challenge-Token for OTP) and the local
  # .env is stale, browser preflight fails silently — surface it here.
  local_cors=$(grep -E '^CORS_ALLOW_HEADERS=' "$PROJECT_ROOT/backend/.env" | head -1 | sed -E 's/^CORS_ALLOW_HEADERS=//; s/^"(.*)"$/\1/' || true)
  example_cors=$(grep -E '^CORS_ALLOW_HEADERS=' "$PROJECT_ROOT/backend/.env.example" | head -1 | sed -E 's/^CORS_ALLOW_HEADERS=//; s/^"(.*)"$/\1/' || true)
  if [ -n "$local_cors" ] && [ -n "$example_cors" ]; then
    missing=""
    IFS=',' read -ra example_arr <<< "$example_cors"
    for h in "${example_arr[@]}"; do
      h_trim=$(echo "$h" | tr -d '[:space:]')
      [ -z "$h_trim" ] && continue
      if ! echo ",$local_cors," | grep -qiF ",$h_trim,"; then
        missing="${missing}${missing:+, }${h_trim}"
      fi
    done
    if [ -n "$missing" ]; then
      has_any_failure=true
      echo -e "  ${WARN} backend/.env CORS_ALLOW_HEADERS missing entries that exist in .env.example: ${missing}"
    elif [ "$QUIET" = false ]; then
      echo -e "  ${PASS} CORS_ALLOW_HEADERS is up to date with .env.example"
    fi
  fi
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
