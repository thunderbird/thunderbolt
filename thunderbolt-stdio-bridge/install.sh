#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# thunderbolt-stdio-bridge installer.
#
# Downloads the prebuilt bridge.cjs bundle from GitHub Releases and installs it
# as a bare command on the npm global bin dir (next to npm/npx). Requires node;
# no Bun, no registry publish, no runtime bundling. bridge.cjs already ships a
# `#!/usr/bin/env node` shebang, so dropping it in under the command name makes
# `thunderbolt-stdio-bridge <args>` behave like any global node CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/thunderbolt-stdio-bridge/install.sh | bash
#
# Pin a version:  ... | bash -s -- 0.1.0
# Custom bin dir: THUNDERBOLT_BIN_DIR=/opt/bin ... | bash
set -euo pipefail

REPO="thunderbird/thunderbolt"
CMD="thunderbolt-stdio-bridge"

command -v node >/dev/null 2>&1 || { echo "error: node is required (https://nodejs.org)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "error: npm is required (ships with node)" >&2; exit 1; }

# Install next to npm/npx (the npm global bin), or honor an explicit override.
BIN_DIR="${THUNDERBOLT_BIN_DIR:-$(npm prefix -g 2>/dev/null)/bin}"
[ -d "$BIN_DIR" ] || mkdir -p "$BIN_DIR"

# Resolve the version: explicit arg/env wins; otherwise read main's package.json
# (always current, no GitHub API call so no rate limit).
VERSION="${1:-${THUNDERBOLT_STDIO_BRIDGE_VERSION:-}}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/thunderbolt-stdio-bridge/package.json" \
    | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$VERSION" ] || { echo "error: could not resolve latest version" >&2; exit 1; }
fi
URL="https://github.com/$REPO/releases/download/stdio-bridge-v$VERSION/bridge.cjs"

echo "Installing $CMD $VERSION -> $BIN_DIR/$CMD"

# Download to a tmp file and move atomically — no half-written command on Ctrl-C.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL"
chmod +x "$TMP"

# The npm global bin may need root (system node / Homebrew) — single-file move.
if [ -w "$BIN_DIR" ]; then
  mv "$TMP" "$BIN_DIR/$CMD"
else
  echo "$BIN_DIR is not writable — using sudo"
  sudo mv "$TMP" "$BIN_DIR/$CMD"
  sudo chmod +x "$BIN_DIR/$CMD"
fi

echo "Installed. Run:  $CMD --help"
