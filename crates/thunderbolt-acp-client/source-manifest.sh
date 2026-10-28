#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Hash paths as well as contents so source additions and removals also go stale.
inputs=(Cargo.toml Cargo.lock build.sh rust-toolchain.toml source-manifest.sh)
if [[ -e build.rs ]]; then
  inputs+=(build.rs)
fi
{
  printf '%s\0' "${inputs[@]}"
  find src .cargo \( -type f -o -type l \) -print0
} | LC_ALL=C sort -z | xargs -0 shasum -a 256
