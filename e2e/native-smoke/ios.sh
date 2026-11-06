#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

cd "$(dirname "$0")/../.."
mkdir -p /tmp/native-smoke
device_id=${IOS_SIMULATOR_UDID:-$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -1)}
test -n "$device_id"
xcrun simctl io "$device_id" recordVideo --codec=h264 --force /tmp/native-smoke/ios.mp4 &
recorder_pid=$!
trap 'kill -INT "$recorder_pid" 2>/dev/null || true; wait "$recorder_pid" 2>/dev/null || true' EXIT

MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true maestro test \
  --udid "$device_id" \
  --debug-output /tmp/native-smoke/maestro-debug \
  -e "EMAIL=native-$(date +%s)-$$@thunderbolt.test" \
  e2e/native-smoke/ios.yaml
