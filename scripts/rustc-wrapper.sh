#!/bin/sh

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

if command -v sccache >/dev/null 2>&1; then
  exec sccache "$@"
fi

exec "$@"
