#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Source in the shell that owns build/install/smoke. Its EXIT trap calls resource_stop.
resource_dir="$RUNNER_TEMP/native-ios-resources"
resource_pid=

resource_marker() {
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$resource_dir/phases.tsv" || true
}

resource_stop() {
  local original_status=$1
  resource_marker "step_exit=$original_status"
  if [ -z "$resource_pid" ]; then
    echo '::warning::iOS resource collector did not start'
    return 0
  fi
  kill -TERM "$resource_pid" 2>/dev/null || true
  if wait "$resource_pid"; then
    printf 'complete\n' > "$resource_dir/status.txt"
  else
    printf 'incomplete: inspect metrics.jsonl and collector.log\n' > "$resource_dir/status.txt"
    echo '::warning::iOS resource collection incomplete; inspect native-ios-resources artifact'
  fi
  return 0
}

mkdir -p "$resource_dir" || return 1
bun "$(dirname "${BASH_SOURCE[0]}")/resources.ts" "$resource_dir" "$$" \
  > "$resource_dir/collector.log" 2>&1 &
resource_pid=$!
trap 'exit 143' TERM
trap 'exit 130' INT

