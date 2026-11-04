#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir"/{bin,scripts,src-tauri/src,registry,glib,git-dep,path-dep}
cp "$script_dir/check-glib-variantstriter.sh" "$test_dir/scripts/"

# Only Cargo is stubbed; the guard parses metadata and scans real source files.
cat > "$test_dir/bin/cargo" <<'EOF'
#!/usr/bin/env bash
if [ "${GLIB_TEST_CARGO_FAILURE:-0}" = 1 ]; then exit 101; fi
cat "$GLIB_TEST_METADATA"
EOF
chmod +x "$test_dir/bin/cargo"
export PATH="$test_dir/bin:$PATH"
export GLIB_TEST_METADATA="$test_dir/metadata.json"
jq -n --arg root "$test_dir" '{packages: [
  {name: "thunderbolt", version: "0.1.0", source: null, manifest_path: ($root + "/src-tauri/Cargo.toml")},
  {name: "glib", version: "0.18.5", source: "registry+https://github.com/rust-lang/crates.io-index", manifest_path: ($root + "/glib/Cargo.toml")},
  {name: "registry-dep", version: "1.0.0", source: "registry+https://github.com/rust-lang/crates.io-index", manifest_path: ($root + "/registry/Cargo.toml")},
  {name: "git-dep", version: "1.0.0", source: "git+https://example.invalid/dependency", manifest_path: ($root + "/git-dep/Cargo.toml")},
  {name: "path-dep", version: "1.0.0", source: null, manifest_path: ($root + "/path-dep/Cargo.toml")}
]}' > "$test_dir/base.json"
cp "$test_dir/base.json" "$GLIB_TEST_METADATA"
echo 'pub struct VariantStrIter;' > "$test_dir/glib/lib.rs"

assert_exit() {
  local label=$1 expected=$2 actual=0
  bash "$test_dir/scripts/check-glib-variantstriter.sh" > "$test_dir/output" 2>&1 || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    echo "FAIL: $label (expected $expected, got $actual)" >&2
    cat "$test_dir/output" >&2
    exit 1
  fi
  echo "PASS: $label"
}

assert_exit 'clean graph excludes the audited glib definitions' 0
for source in registry/lib.rs path-dep/lib.rs git-dep/lib.rs src-tauri/src/lib.rs src-tauri/build.rs; do
  echo 'fn caller(v: glib::Variant) { v.array_iter_str(); }' > "$test_dir/$source"
  assert_exit "caller in $source" 1
  rm "$test_dir/$source"
done

echo 'use glib::VariantStrIter as Strings;' > "$test_dir/path-dep/lib.rs"
assert_exit 'type reference in a path dependency' 1
rm "$test_dir/path-dep/lib.rs"

for mutation in \
  '.packages |= map(select(.name != "glib"))' \
  '.packages[1].version = "0.18.6"' \
  '.packages[1].source = null' \
  '.packages += [.packages[1] | .version = "0.20.0"]'; do
  jq "$mutation" "$test_dir/base.json" > "$GLIB_TEST_METADATA"
  assert_exit "glib audit assumption changed: $mutation" 2
done

cp "$test_dir/base.json" "$GLIB_TEST_METADATA"
rmdir "$test_dir/git-dep"
assert_exit 'missing dependency source fails closed' 2
mkdir "$test_dir/git-dep"
GLIB_TEST_CARGO_FAILURE=1 assert_exit 'Cargo resolution failure fails closed' 2
echo '{ invalid json' > "$GLIB_TEST_METADATA"
assert_exit 'invalid metadata fails closed' 2
