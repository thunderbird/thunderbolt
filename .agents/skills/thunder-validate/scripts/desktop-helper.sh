#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail
# User-run bridge: no GUI automation; delegates safe clipboard and log operations.
if [[ ${1:-} == --help || $# -lt 1 ]]; then
  cat <<'HELP'
Usage: bash desktop-helper.sh otp --log LOG --email EMAIL
       bash desktop-helper.sh key NAME | clear
       bash desktop-helper.sh mark --log LOG LABEL
       bash desktop-helper.sh events --log LOG FROM [TO]
Inputs: private backend log, test email, ~/.argent/secrets.env. Output: status or safe proxy event fields.
Side effects: otp/key/clear replace macOS clipboard; mark writes <LOG>.marks.json.
Run in YOUR terminal when the Claude Desktop agent asks. Never paste clipboard contents into chat.
HELP
  exit 0
fi
skill_scripts=$(cd "$(dirname "$0")" && pwd)
operation=$1
shift
case "$operation" in
  otp) python3 "$skill_scripts/otp.py" "$@" ;;
  key) python3 "$skill_scripts/secrets.py" clip "$@" ;;
  clear) python3 "$skill_scripts/secrets.py" clear "$@" ;;
  mark|events)
    [[ ${1:-} == --log && $# -ge 3 ]] || { echo 'Use mark|events --log LOG LABEL [TO]; see --help.' >&2; exit 2; }
    log=$2
    shift 2
    bash "$skill_scripts/log-marks.sh" --log "$log" "$operation" "$@" ;;
  *) echo 'Unknown operation; see --help.' >&2; exit 2 ;;
esac
