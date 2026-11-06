# shellcheck shell=bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Sourced from the repo root (`. .github/qa/scripts/ports.sh`). Exports each QA_*_PORT from the environment, else its
# default from .github/qa/ports.json. A value that is not a port number exits 2.

while read -r name default; do
  port=${!name:-$default}
  if ! [[ $port =~ ^[1-9][0-9]{0,4}$ ]] || [ "$port" -gt 65535 ]; then
    echo "$name must be a port number from 1 to 65535, got '$port'" >&2
    exit 2
  fi
  export "$name=$port"
done < <(jq -r 'to_entries[] | "\(.key) \(.value)"' .github/qa/ports.json)
