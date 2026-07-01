#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Build the Thunderbolt ACP iroh client to WebAssembly for the web app.
#
# Output: a wasm-pack `pkg/` at `src/acp/iroh/pkg/` (the app lazy-imports the
# glue from there). Re-run after changing the crate.
#
# Toolchain (one-time):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack        # or the prebuilt installer
#
# macOS caveat: `ring` (TLS backend) compiles C to wasm32, and Apple's system
# clang has NO wasm backend. Install Homebrew LLVM and this script points the
# wasm C toolchain at it. Linux CI usually ships a wasm-capable clang already.
#   brew install llvm
#
# Size: this script runs `wasm-opt -Oz` from a current Homebrew binaryen
# (`brew install binaryen`). wasm-pack's bundled wasm-opt is too old to validate
# the bulk-memory ops rustc emits, so it's disabled in Cargo.toml.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/src/acp/iroh/pkg}"

# The committed artifacts, checksummed into CHECKSUMS.txt for tamper-evidence
# (CI verifies the tree against it) and reproducibility (`--verify` below).
ARTIFACTS=(
  thunderbolt_acp_client_bg.wasm
  thunderbolt_acp_client_bg.wasm.d.ts
  thunderbolt_acp_client.d.ts
  thunderbolt_acp_client.js
  package.json
)

# `--verify` rebuilds into a throwaway dir and fails if the result drifts from the
# committed CHECKSUMS.txt, instead of overwriting src/acp/iroh/pkg. The build is
# byte-for-byte reproducible only on the pinned toolchain and OS (see README.md).
VERIFY=0
if [[ "${1:-}" == "--verify" ]]; then
  VERIFY=1
  COMMITTED_DIR="$OUT_DIR"
  OUT_DIR="$(mktemp -d)"
  trap 'rm -rf "$OUT_DIR"' EXIT
fi

if [[ "$(uname)" == "Darwin" ]]; then
  LLVM_PREFIX="${LLVM_PREFIX:-/opt/homebrew/opt/llvm}"
  if [[ ! -x "$LLVM_PREFIX/bin/clang" ]]; then
    echo "error: Homebrew LLVM clang not found at $LLVM_PREFIX/bin/clang." >&2
    echo "       Run 'brew install llvm' (Apple clang can't target wasm32)." >&2
    exit 1
  fi
  CLANG_VER="$(ls "$LLVM_PREFIX/lib/clang" | sort -V | tail -1)"
  export CC_wasm32_unknown_unknown="$LLVM_PREFIX/bin/clang"
  export AR_wasm32_unknown_unknown="$LLVM_PREFIX/bin/llvm-ar"
  export CFLAGS_wasm32_unknown_unknown="-I$LLVM_PREFIX/lib/clang/$CLANG_VER/include"
fi

cd "$CRATE_DIR"
echo "building wasm → $OUT_DIR"
wasm-pack build --target web --release --out-dir "$OUT_DIR"

WASM="$OUT_DIR/thunderbolt_acp_client_bg.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  echo "optimizing with $(wasm-opt --version)"
  # Enable the wasm features LLVM emits — the release profile's `strip` drops the
  # target-features section, so wasm-opt can't auto-detect them and defaults to MVP.
  wasm-opt -Oz \
    --enable-bulk-memory --enable-bulk-memory-opt \
    --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    "$WASM" -o "$WASM.opt"
  mv "$WASM.opt" "$WASM"
else
  echo "warning: wasm-opt not found — shipping the unoptimized artifact. 'brew install binaryen' to shrink it." >&2
fi

# wasm-pack writes a '*' .gitignore into the out-dir; drop it so the build
# artifact can be committed (the app imports it without a wasm toolchain in CI).
rm -f "$OUT_DIR/.gitignore"

# Manifest of the committed artifacts (bare filenames, so it's path-independent
# and CI can `shasum -a 256 -c` it from the pkg dir without a wasm toolchain).
( cd "$OUT_DIR" && shasum -a 256 "${ARTIFACTS[@]}" > CHECKSUMS.txt )

if [[ "$VERIFY" == 1 ]]; then
  if diff -u "$COMMITTED_DIR/CHECKSUMS.txt" "$OUT_DIR/CHECKSUMS.txt"; then
    echo "verify: rebuilt artifacts match committed CHECKSUMS.txt"
  else
    echo "verify: DRIFT — rebuilt artifacts differ from committed CHECKSUMS.txt" >&2
    exit 1
  fi
  exit 0
fi

echo "done. artifact:"
ls -lh "$WASM"
