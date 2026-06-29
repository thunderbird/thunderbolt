#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# thunderbolt installer.
#
# Downloads the prebuilt thunderbolt.cjs bundle from GitHub Releases and installs
# it as a bare command on the npm global bin dir (next to npm/npx). Requires node;
# no Bun, no registry publish, no runtime bundling. thunderbolt.cjs already ships a
# `#!/usr/bin/env node` shebang, so dropping it in under the command name makes
# `thunderbolt <args>` behave like any global node CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/cli/install.sh | bash
#
# Pin a version:  ... | bash -s -- 0.1.0
# Custom bin dir: THUNDERBOLT_BIN_DIR=/opt/bin ... | bash
set -euo pipefail

REPO="thunderbird/thunderbolt"
CMD="thunderbolt"

command -v node >/dev/null 2>&1 || { echo "error: node is required (https://nodejs.org)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "error: npm is required (ships with node)" >&2; exit 1; }

# Install next to npm/npx (the npm global bin), or honor an explicit override.
# Without an override, resolve the npm global prefix and refuse to proceed if it
# is empty — never fall back to a bare `/bin`, which would be wrong and unsafe.
if [ -n "${THUNDERBOLT_BIN_DIR:-}" ]; then
  BIN_DIR="$THUNDERBOLT_BIN_DIR"
else
  prefix="$(npm prefix -g 2>/dev/null)"
  [ -n "$prefix" ] && [ -d "$prefix" ] || {
    echo "error: could not resolve the npm global prefix (npm prefix -g)." >&2
    echo "       set THUNDERBOLT_BIN_DIR=/path/to/bin and re-run." >&2
    exit 1
  }
  BIN_DIR="$prefix/bin"
fi
[ -d "$BIN_DIR" ] || mkdir -p "$BIN_DIR"

# Resolve the version: explicit arg/env wins; otherwise read main's package.json
# (always current, no GitHub API call so no rate limit).
VERSION="${1:-${THUNDERBOLT_VERSION:-}}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/cli/package.json" \
    | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$VERSION" ] || { echo "error: could not resolve latest version" >&2; exit 1; }
fi
URL="https://github.com/$REPO/releases/download/thunderbolt-v$VERSION/thunderbolt.cjs"
SUM_URL="$URL.sha256"

echo "Installing $CMD $VERSION -> $BIN_DIR/$CMD"

# Download to a tmp file and move atomically — no half-written command on Ctrl-C.
TMP=$(mktemp)
SUM_TMP=$(mktemp)
trap 'rm -f "$TMP" "$SUM_TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL"

# Verify the download against the Release's published SHA-256 before installing.
# Pick whichever checksum tool is present; the published file is in `shasum -c`
# format (`<hex>  thunderbolt.cjs`), so verify from $TMP's own directory under that
# basename. Abort on mismatch or a missing tool — never install unverified bytes.
curl -fsSL -o "$SUM_TMP" "$SUM_URL"
EXPECTED=$(awk '{print $1; exit}' "$SUM_TMP")
[ -n "$EXPECTED" ] || { echo "error: could not read published checksum" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then
  echo "$EXPECTED  $TMP" | shasum -a 256 -c - >/dev/null 2>&1 \
    || { echo "error: checksum verification failed for thunderbolt.cjs" >&2; exit 1; }
elif command -v sha256sum >/dev/null 2>&1; then
  echo "$EXPECTED  $TMP" | sha256sum -c - >/dev/null 2>&1 \
    || { echo "error: checksum verification failed for thunderbolt.cjs" >&2; exit 1; }
else
  echo "error: need shasum or sha256sum to verify the download" >&2; exit 1
fi

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
