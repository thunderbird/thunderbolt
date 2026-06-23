#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# -----------------------------------------------------------------------------
# check-glib-variantstriter.sh
# -----------------------------------------------------------------------------
# Security tripwire for GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429:
# "Unsoundness in Iterator/DoubleEndedIterator impls for glib::VariantStrIter".
#
# glib 0.18.5 ships (Linux desktop only) in our build graph, transitively via
# the gtk-rs / webkit2gtk / wry / tao stack that Tauri 2.x pins. The unsound
# `glib::VariantStrIter::impl_get` passes an immutable ref to a NULL pointer to
# a variadic C out-arg; recent rustc elides the write, so a later
# `CStr::from_ptr` null-derefs → process crash (DoS). It triggers when a
# `VariantStrIter` is iterated.
#
# We ACCEPT this risk only because that path is dead code: the sole public
# producer of a VariantStrIter is `glib::Variant::array_iter_str()`, and it has
# ZERO callers anywhere in our source or the entire dependency graph. (The
# common `Variant::get::<Vec<String>>()` path uses a different, safe per-element
# iterator and never touches it.) A clean fix is blocked — gtk 0.18.x hard-pins
# `glib ^0.18`, glib 0.18.5 is the terminal 0.18.x release with no backport, and
# glib >= 0.20 (the patched line) requires the Tauri V3 / gtk4-rs migration.
#
# This script locks that "zero callers" invariant. It resolves the actual Linux
# build graph (glib only ships on Linux), then greps every dependency's source —
# plus our own src-tauri/src — for the symbol, EXCLUDING the `glib` crate where
# it is legitimately defined. Any hit means the unsound path may now be
# reachable in a shipped Linux binary.
#
# If this fails, do NOT silence it. Either:
#   * use the safe `Variant::get::<Vec<String>>()` path instead, or
#   * bump glib >= 0.20 (needs the Tauri V3 / gtk4-rs upgrade).
#
# Assumptions (re-audit if any change):
#   * Pinned to glib 0.18.5, whose only public producer of a VariantStrIter is
#     Variant::array_iter_str(). If Cargo.lock bumps glib, re-audit
#     GHSA-wrw7-89jp-8q8g — a new producer/method may need a new pattern.
#   * One first-party crate (src-tauri); add any new workspace members below.
#   * Matches text in any *.rs (comments included) — intentional fail-safe: a
#     hit means "investigate", never "weaken the pattern".
#
# Cheap by design: `cargo metadata` + grep, no compilation.
# -----------------------------------------------------------------------------

set -euo pipefail

# Any Linux target resolves the same gtk-rs/glib graph; one triple suffices.
readonly TARGET_TRIPLE="x86_64-unknown-linux-gnu"
readonly PATTERN='\b(array_iter_str|VariantStrIter)\b'
readonly EXCLUDED_CRATE="glib"

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

# Registry dependency source directories — EXCLUDING the glib crate that
# legitimately defines the symbol (excluded by package name, so glib-sys /
# glib-macros stay in scope). jq does the dirname + dedup.
registry_dirs="$(
  jq -r --arg excl "$EXCLUDED_CRATE" '
    [ .packages[]
      | select(.source != null and (.source | startswith("registry+")))
      | select(.name != $excl)
      | .manifest_path | rtrimstr("/Cargo.toml")
    ] | unique | .[]' <<< "$metadata"
)" || { echo "❌ failed to parse cargo metadata output with jq. Aborting." >&2; exit 2; }

# Source trees to scan: our own crate, plus every resolved dependency source.
# `cargo metadata` extracts the sources we then grep.
scan_dirs=("$repo_root/src-tauri/src")
while IFS= read -r dir; do
  [ -n "$dir" ] && scan_dirs+=("$dir")
done <<< "$registry_dirs"

# False-negative guard: if resolution yielded only our own crate, the dependency
# graph is missing — refuse to "pass" without actually scanning anything.
if [ "${#scan_dirs[@]}" -le 1 ]; then
  echo "❌ cargo metadata resolved no registry dependencies — cannot verify. Aborting." >&2
  exit 2
fi

echo "▶ Scanning ${#scan_dirs[@]} source trees for glib::VariantStrIter callers…"

set +e
hits="$(grep -rnE --include='*.rs' "$PATTERN" "${scan_dirs[@]}" 2>&1)"
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
  echo "   This re-enables GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429 (unsound null-deref → crash)." >&2
  echo "   Offending reference(s):" >&2
  echo "$hits" | sed 's/^/     /' >&2
  echo "" >&2
  echo "   Fix: use the safe Variant::get::<Vec<String>>() path, or bump glib >= 0.20" >&2
  echo "   (requires the Tauri V3 / gtk4-rs migration; gtk 0.18.x hard-pins glib ^0.18)." >&2
  exit 1
fi

echo "✅ No callers of glib::VariantStrIter / Variant::array_iter_str() outside the glib crate."
echo "   GHSA-wrw7-89jp-8q8g accept-risk invariant holds."
