#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# One exploratory QA session, as the weekly workflow runs it, against a stack started with stack.sh.
#
#   .github/qa/scripts/explore.sh prompt <charter> <out-dir>         print the session prompt (the workflow uses it)
#   .github/qa/scripts/explore.sh run <charter> <out-dir> [max-usd]  run the session locally with `claude -p` ($2)
#   .github/qa/scripts/explore.sh journey [<case>]                   print this week's free-session case, or check one
#
# `run` needs ANTHROPIC_API_KEY. It writes <out-dir>/<charter>/{findings,repro,attempts}/ (the explorer),
# execution.json + session.json (metrics) and transcript.json (the tool calls, for the coverage check).
# The phone charter needs QA_MCP_VIEWPORT=390x844, the two-device charter
# QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json' (its second browser). The free session of a case in journeys.json on a platform in
# platforms.json is the charter free-<case>-<platform> (its viewport and MCP config come from platforms.json), e.g.
# `run "free-$(.github/qa/scripts/explore.sh journey)-phone" qa-out` for this week's case on the phone.
# Keep the claude flags in step with the explore job in .github/workflows/qa-weekly.yml.

set -euo pipefail
cd "$(dirname "$0")/../../.."

# One field of a platform in platforms.json.
platform() {
  jq --exit-status --raw-output --arg id "$1" ".[] | select(.id == \$id) | .$2" .github/qa/platforms.json ||
    { echo "unknown platform: $1" >&2; exit 1; }
}

# A free session's case: the given id, or this week's. Unix weeks start on Thursday, so consecutive Monday runs take
# consecutive cases and every case runs once before any repeats.
journey() {
  jq --exit-status --raw-output --arg id "$1" --argjson week $(($(date +%s) / 604800)) \
    'if $id == "" then .[$week % length].id else .[] | select(.id == $id) | .id end' .github/qa/journeys.json ||
    { echo "unknown case: $1" >&2; exit 1; }
}

# The shared prefix comes first and is identical for every charter, so sessions can reuse its prompt cache.
prompt() {
  cat .github/qa/prompt.md
  # The model's "random" addresses repeat across sessions, so each run gets its own.
  # shellcheck disable=SC2016 # the backticks are Markdown
  printf '\n## Your run\n\n- Charter id: `%s`\n- Output directory: `%s/%s`\n- Fresh addresses: `qa-%s-%s-<n>@thunderbolt.test`, n = 1, 2, 3…\n\n' \
    "$1" "$2" "$1" "$1" "$(date +%s)"
  if [[ $1 == free-* ]]; then
    # free-<case>-<platform>: platform ids have no hyphen, so the last part names the platform.
    local viewport id=${1#free-}
    viewport=$(platform "${1##*-}" viewport)
    id=$(journey "${id%-*}")
    # shellcheck disable=SC2016 # the backticks are Markdown
    printf '## Your case (free session)\n\nPlatform: `%s`, a %s screen.\n\n```json\n' "${1##*-}" "$viewport"
    jq --arg id "$id" '.[] | select(.id == $id) | del(.pt)' .github/qa/journeys.json
    printf '```\n'
    return
  fi
  cat ".github/qa/charters/$1.md"
  printf '\n## Functions to test\n\nEach id, then the outcome that shows the function works.\n\n'
  # shellcheck disable=SC2016 # jq string interpolation
  jq --raw-output --arg charter "$1" \
    '.[$charter][] | "- `\(.id)`: \(.outcome)\(if .reload then " (after a reload)" else "" end)"' .github/qa/functions.json
}

run() {
  local charter=$1 out=$2 dir=$2/$1 config
  if [[ $charter == free-* ]]; then
    QA_MCP_VIEWPORT=$(platform "${charter##*-}" viewport)
    QA_MCP_CONFIG=$(platform "${charter##*-}" mcp)
    export QA_MCP_VIEWPORT
  fi
  mkdir -p "$dir"
  config=$(mktemp -d)
  # An empty config dir: no user settings, hooks, memory or login. The exit code is read from the result instead.
  # shellcheck disable=SC2086 # QA_MCP_CONFIG holds one config file per word
  QA_OUT=$out CLAUDE_CONFIG_DIR=$config claude -p "$(prompt "$charter" "$out")" \
    --model claude-sonnet-5-5 \
    --setting-sources user \
    --permission-mode dontAsk \
    --tools Write \
    --allowedTools "mcp__playwright__*" "mcp__playwright_b__*" "Edit($out/**)" \
    --disallowedTools mcp__playwright__browser_run_code_unsafe mcp__playwright_b__browser_run_code_unsafe \
    --strict-mcp-config --mcp-config ${QA_MCP_CONFIG:-.github/qa/mcp.json} \
    --max-budget-usd "${3:-2}" --max-turns 400 \
    --output-format stream-json --verbose --no-session-persistence < /dev/null > "$dir/run.jsonl" || true
  rm -rf "$config"
  jq --slurp . "$dir/run.jsonl" > "$dir/execution.json"
  jq --compact-output --from-file .github/qa/transcript.jq "$dir/execution.json" > "$dir/transcript.json"
  bun .github/qa/scripts/report.ts session --execution-file "$dir/execution.json" --charter "$charter" --out "$out"
  cat "$dir/session.json"
}

case "${1:-}" in
  prompt) prompt "$2" "$3" ;;
  run) run "$2" "$3" "${4:-2}" ;;
  journey) journey "${2:-}" ;;
  *) echo "usage: $0 prompt <charter> <out-dir> | run <charter> <out-dir> [max-usd] | journey [<case>]" >&2; exit 2 ;;
esac
