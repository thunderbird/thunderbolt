#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

cd "$(dirname "$0")/../.."
test_dir=$(mktemp -d)
cat > "$test_dir/bun" <<'EOF'
#!/usr/bin/env bash
exec sleep 30
EOF
chmod +x "$test_dir/bun"

sleep 30 &
unrelated_pid=$!
PATH="$test_dir:$PATH" ./e2e/native-smoke/services.sh &
launcher_pid=$!
children=
cleanup() {
  kill "$launcher_pid" "$unrelated_pid" 2>/dev/null || true
  for child in $children; do kill "$child" 2>/dev/null || true; done
  wait "$launcher_pid" "$unrelated_pid" 2>/dev/null || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

for _ in {1..30}; do
  children=$(pgrep -P "$launcher_pid" || true)
  if [ "$(wc -w <<< "$children")" -eq 2 ]; then break; fi
  sleep 0.1
done
test "$(wc -w <<< "$children")" -eq 2

kill "$launcher_pid"
wait "$launcher_pid" 2>/dev/null || true
for child in $children; do
  if kill -0 "$child" 2>/dev/null; then
    echo "Native service child $child survived launcher termination" >&2
    exit 1
  fi
done
kill -0 "$unrelated_pid"
