#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/crate/src" "$TEST_DIR/crate/.cargo"
cp "$CRATE_DIR/source-manifest.sh" "$TEST_DIR/crate/"
for input in Cargo.toml Cargo.lock build.sh rust-toolchain.toml src/lib.rs .cargo/config.toml; do
  printf 'original\n' > "$TEST_DIR/crate/$input"
done

manifest() {
  bash "$TEST_DIR/crate/source-manifest.sh"
}

expect_stale() {
  if manifest | diff -u "$TEST_DIR/SOURCES.txt" - > /dev/null; then
    echo "error: stale source manifest accepted: $1" >&2
    exit 1
  fi
}

manifest > "$TEST_DIR/SOURCES.txt"
manifest | diff -u "$TEST_DIR/SOURCES.txt" -
# Absolute checkout location and unrelated crate documentation don't affect it.
printf 'documentation\n' > "$TEST_DIR/crate/README.md"
manifest | diff -u "$TEST_DIR/SOURCES.txt" -
cp -R "$TEST_DIR/crate" "$TEST_DIR/other-checkout"
bash "$TEST_DIR/other-checkout/source-manifest.sh" | diff -u "$TEST_DIR/SOURCES.txt" -

for input in Cargo.toml Cargo.lock build.sh rust-toolchain.toml src/lib.rs .cargo/config.toml source-manifest.sh; do
  cp "$TEST_DIR/crate/$input" "$TEST_DIR/original"
  printf '\n# changed\n' >> "$TEST_DIR/crate/$input"
  expect_stale "changed $input"
  cp "$TEST_DIR/original" "$TEST_DIR/crate/$input"
done
for input in src/added.rs .cargo/extra.toml build.rs; do
  printf 'new source\n' > "$TEST_DIR/crate/$input"
  expect_stale "added $input"
  rm "$TEST_DIR/crate/$input"
done
for input in src/lib.rs .cargo/config.toml Cargo.lock; do
  mv "$TEST_DIR/crate/$input" "$TEST_DIR/original"
  expect_stale "removed $input"
  mv "$TEST_DIR/original" "$TEST_DIR/crate/$input"
done

cp "$TEST_DIR/SOURCES.txt" "$TEST_DIR/original-manifest"
sed '1d' "$TEST_DIR/original-manifest" > "$TEST_DIR/SOURCES.txt"
expect_stale 'omitted manifest entry'
sed 's/./0/' "$TEST_DIR/original-manifest" > "$TEST_DIR/SOURCES.txt"
expect_stale 'tampered manifest digest'
cp "$TEST_DIR/original-manifest" "$TEST_DIR/SOURCES.txt"
manifest | diff -u "$TEST_DIR/SOURCES.txt" -

# Exercise the real build script with command fixtures, without compiling wasm.
cp "$CRATE_DIR/build.sh" "$TEST_DIR/crate/build.sh"
mkdir "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/uname" <<'COMMAND'
#!/usr/bin/env bash
echo Linux
COMMAND
cat > "$TEST_DIR/bin/wasm-pack" <<'COMMAND'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'-- --locked' ]]
if [[ "$TEST_BUILD_MODE" == failed ]]; then exit 1; fi
while [[ "$1" != --out-dir ]]; do shift; done
mkdir -p "$2"
for artifact in thunderbolt_acp_client_bg.wasm thunderbolt_acp_client_bg.wasm.d.ts thunderbolt_acp_client.d.ts thunderbolt_acp_client.js package.json; do
  printf 'fixture\n' > "$2/$artifact"
done
if [[ "$TEST_BUILD_MODE" == changed-lock ]]; then printf '\n# changed\n' >> Cargo.lock; fi
if [[ "$TEST_BUILD_MODE" == changed-source ]]; then printf '\n# changed\n' >> src/lib.rs; fi
COMMAND
cat > "$TEST_DIR/bin/wasm-opt" <<'COMMAND'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == --version ]]; then echo 'wasm-opt fixture'; exit; fi
while [[ "$1" != -o ]]; do shift; done
printf 'optimized fixture\n' > "$2"
COMMAND
chmod +x "$TEST_DIR/bin/"*
for mode in failed changed-lock changed-source; do
  if PATH="$TEST_DIR/bin:$PATH" TEST_BUILD_MODE="$mode" OUT_DIR="$TEST_DIR/pkg-$mode" \
    bash "$TEST_DIR/crate/build.sh" > "$TEST_DIR/build.log" 2>&1; then
    echo "error: build accepted $mode" >&2
    exit 1
  fi
  test ! -e "$TEST_DIR/pkg-$mode/SOURCES.txt"
  test ! -e "$TEST_DIR/pkg-$mode/CHECKSUMS.txt"
done
PATH="$TEST_DIR/bin:$PATH" TEST_BUILD_MODE=success OUT_DIR="$TEST_DIR/pkg-success" \
  bash "$TEST_DIR/crate/build.sh" > "$TEST_DIR/build.log" 2>&1
manifest | diff -u "$TEST_DIR/pkg-success/SOURCES.txt" -
(cd "$TEST_DIR/pkg-success" && shasum -a 256 -c CHECKSUMS.txt > /dev/null)
PATH="$TEST_DIR/bin:$PATH" TEST_BUILD_MODE=success OUT_DIR="$TEST_DIR/pkg-success" \
  bash "$TEST_DIR/crate/build.sh" --verify > "$TEST_DIR/build.log" 2>&1
echo 'source manifest checks passed'
