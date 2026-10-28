#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g remains open in glib 0.18.5.
# Risk acceptance depends on finding no references to VariantStrIter or its
# producer array_iter_str outside that audited upstream crate. This text scan
# is a tripwire, not proof that the vulnerable code is absent from a binary.
# See docs/internals/development/ci-and-previews.md for the upgrade constraints.
#
# Scan all package sources, including path/git dependencies and build scripts.
# Comments count as hits: investigate them rather than weakening the pattern.
# shortcut: macro-generated references and Rust sources outside package roots
# can escape this scan; re-audit when adding code generation or include! paths.

set -euo pipefail

# CI checks both shipped Linux architectures.
readonly TARGET_TRIPLE="${1:-x86_64-unknown-linux-gnu}"
readonly PATTERN='\b(array_iter_str|VariantStrIter)\b'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

echo "▶ Resolving Linux build graph (cargo metadata --filter-platform $TARGET_TRIPLE)…"

# Resolve and parse in two explicit steps (not a process substitution) so a
# cargo/jq failure is caught with a correct message instead of slipping past
# `set -e` and looking like "no dependencies".
metadata="$(
  cargo metadata \
    --manifest-path "$repo_root/src-tauri/Cargo.toml" \
    --filter-platform "$TARGET_TRIPLE" \
    --format-version 1 \
    --locked
)" || { echo "❌ cargo metadata failed (stale Cargo.lock or manifest issue?). Aborting." >&2; exit 2; }

# Excluding a different glib release or fork would silently reuse an old audit.
if ! jq -e '
  [.packages[] | select(.name == "glib")]
  | length == 1
    and .[0].version == "0.18.5"
    and .[0].source == "registry+https://github.com/rust-lang/crates.io-index"
' <<< "$metadata" > /dev/null; then
  echo "ERROR: expected one upstream glib 0.18.5; re-audit RUSTSEC-2024-0429 before changing this guard." >&2
  exit 2
fi

source_dirs="$(
  jq -r '
    [.packages[] | select(.name != "glib")
      | .manifest_path | rtrimstr("/Cargo.toml")]
    | unique | .[]' <<< "$metadata"
)" || { echo "ERROR: failed to parse cargo metadata source paths. Aborting." >&2; exit 2; }

scan_dirs=()
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  if [ ! -d "$dir" ]; then
    echo "ERROR: missing package source directory: $dir" >&2
    exit 2
  fi
  scan_dirs+=("$dir")
done <<< "$source_dirs"

# Refuse to pass if the graph contains nothing to scan.
if [ "${#scan_dirs[@]}" -eq 0 ]; then
  echo "❌ cargo metadata resolved no source directories — cannot verify. Aborting." >&2
  exit 2
fi

echo "▶ Scanning ${#scan_dirs[@]} source trees for glib::VariantStrIter callers…"

set +e
hits="$(grep -RnE --include='*.rs' "$PATTERN" "${scan_dirs[@]}" 2>&1)"
rc=$?
set -e

# grep exit codes: 0 = caller found, 1 = clean, >1 = error (e.g. a source tree
# was never extracted — run `cargo fetch`). Never pass on an error.
if [ "$rc" -gt 1 ]; then
  echo "❌ Could not scan all dependency sources (grep exit $rc) — they may not be" >&2
  echo "   extracted; run 'cargo fetch' first. Refusing to pass without scanning." >&2
  echo "$hits" | sed 's/^/     /' >&2
  exit 2
fi

if [ "$rc" -eq 0 ]; then
  echo "❌ SECURITY: a caller of glib::VariantStrIter / Variant::array_iter_str() was found." >&2
  echo "   Risk acceptance for GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429 needs review." >&2
  echo "   Offending reference(s):" >&2
  echo "$hits" | sed 's/^/     /' >&2
  echo "" >&2
  echo "   Use Variant::get::<Vec<String>>() where suitable, or a reviewed compatible backport." >&2
  echo "   A glib upgrade requires compatible GTK/WebKit/runtime dependencies together." >&2
  exit 1
fi

echo "✅ No callers of glib::VariantStrIter / Variant::array_iter_str() outside the glib crate."
echo "   Static risk-acceptance check passed; RUSTSEC-2024-0429 remains unpatched."
