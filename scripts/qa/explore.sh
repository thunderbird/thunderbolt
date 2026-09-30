#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# One exploratory QA session, as the weekly workflow runs it, against a stack started with scripts/qa/stack.sh.
#
#   scripts/qa/explore.sh prompt <charter> <out-dir>          print the session prompt (the workflow uses this too)
#   scripts/qa/explore.sh run <charter> <out-dir> [max-usd]   run the session locally with `claude -p` (default $2)
#
# `run` needs ANTHROPIC_API_KEY. It writes <out-dir>/<charter>/{findings,repro}/ (the explorer),
# execution.json + session.json (metrics) and findings.json (the summary, only if the session finished).
# The phone charter needs QA_MCP_VIEWPORT=390x844, the two-device charter QA_MCP_CONFIG=qa/mcp-two-devices.json.
# Keep the claude flags in step with the explore job in .github/workflows/qa-weekly.yml.

set -euo pipefail
cd "$(dirname "$0")/../.."

# The shared prefix comes first and is identical for every charter, so sessions can reuse its prompt cache.
prompt() {
  cat qa/prompt.md
  # shellcheck disable=SC2016 # the backticks are Markdown
  printf '\n## Your run\n\n- Charter id: `%s`\n- Output directory: `%s/%s`\n\n' "$1" "$2" "$1"
  cat "qa/charters/$1.md"
}

run() {
  local charter=$1 out=$2 dir=$2/$1 config
  mkdir -p "$dir"
  config=$(mktemp -d)
  # An empty config dir: no user settings, hooks, memory or login. The exit code is read from the result instead.
  QA_OUT=$out CLAUDE_CONFIG_DIR=$config claude -p "$(prompt "$charter" "$out")" \
    --model claude-sonnet-5-5 \
    --setting-sources user \
    --permission-mode dontAsk \
    --tools Write \
    --allowedTools "mcp__playwright__*" "mcp__playwright_b__*" "Edit($out/**)" \
    --disallowedTools mcp__playwright__browser_run_code_unsafe mcp__playwright_b__browser_run_code_unsafe \
    --strict-mcp-config --mcp-config "${QA_MCP_CONFIG:-qa/mcp.json}" \
    --json-schema "$(cat qa/findings.schema.json)" \
    --max-budget-usd "${3:-2}" --max-turns 400 \
    --output-format stream-json --verbose --no-session-persistence < /dev/null > "$dir/run.jsonl" || true
  rm -rf "$config"
  jq --slurp . "$dir/run.jsonl" > "$dir/execution.json"
  bun scripts/qa/report.ts session --execution-file "$dir/execution.json" --charter "$charter" --out "$out"
  jq --exit-status 'last | .structured_output // empty' "$dir/execution.json" > "$dir/findings.json" ||
    rm "$dir/findings.json"
  cat "$dir/session.json"
}

case "${1:-}" in
  prompt) prompt "$2" "$3" ;;
  run) run "$2" "$3" "${4:-2}" ;;
  *) echo "usage: $0 prompt <charter> <out-dir> | run <charter> <out-dir> [max-usd]" >&2; exit 2 ;;
esac
