#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo 'Linux tauri-driver needs WebKitWebDriver; this host is not Linux' >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
mkdir -p /tmp/thu-886-native-smoke
if [ -z "${DISPLAY:-}" ]; then
  exec xvfb-run -a -s '-screen 0 1600x1200x24' "$0"
fi
command -v tauri-driver
command -v WebKitWebDriver

ffmpeg -loglevel error -y -f x11grab -framerate 15 -video_size 1600x1200 \
  -i "$DISPLAY" -c:v libx264 -pix_fmt yuv420p /tmp/thu-886-native-smoke/linux.mp4 &
recorder_pid=$!
XDG_CONFIG_HOME=$(mktemp -d)
XDG_DATA_HOME=$(mktemp -d)
XDG_CACHE_HOME=$(mktemp -d)
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
# WebKitGTK otherwise paints a blank window under Xvfb.
export WEBKIT_DISABLE_COMPOSITING_MODE=1
tauri-driver --port 4444 > /tmp/thu-886-native-smoke/tauri-driver.log 2>&1 &
driver_pid=$!
trap 'kill -INT "$recorder_pid" 2>/dev/null || true; kill "$driver_pid" 2>/dev/null || true; wait "$recorder_pid" 2>/dev/null || true; wait "$driver_pid" 2>/dev/null || true' EXIT

for _ in {1..30}; do
  if curl -fsS http://localhost:4444/status >/dev/null; then break; fi
  sleep 1
done

bun e2e/native-smoke/linux.ts
