#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"
bunx vite build --config ios/Runtime/vite.config.ts
bunx vite build --config ios/Runtime/artifact-vite.config.ts
bunx vite build --config ios/Runtime/search-vite.config.ts
