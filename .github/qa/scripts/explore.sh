#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# One exploratory QA session, as the weekly workflow runs it, against a stack started with stack.sh.
#
#   .github/qa/scripts/explore.sh prompt <session> <out-dir>         print the session prompt (the workflow uses it)
#   .github/qa/scripts/explore.sh run <session> <out-dir> [max-usd]  run the session locally with `claude -p` ($2)
#   .github/qa/scripts/explore.sh canary <session> <out-dir>         check that the gate denies a native session
#   .github/qa/scripts/explore.sh journey [<case>]                   print this week's free-session case, or check one
#   .github/qa/scripts/explore.sh harness <session> <dir>            CI: a native session's gate, hook and config in <dir>
#
# A session is <charter>-<platform>, e.g. c4-skills-projects-phone, or free-<case>-<platform> for the free session of a
# case in journeys.json (platform ids are in platforms.json and never contain a hyphen), e.g.
# `run "free-$(.github/qa/scripts/explore.sh journey)-phone" qa-out` for this week's case on the phone.
# `run` needs ANTHROPIC_API_KEY. It writes <out-dir>/<session>/{findings,repro,attempts}/ (the explorer), mcp/ (the
# browser's screenshots and console logs),
# execution.json + session.json (metrics) and transcript.json (the tool calls, for the coverage check).
# The platform sets the viewport and the MCP config. The two-device charter needs
# QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json' (its second browser).
# Keep the claude flags in step with the explore job in .github/workflows/qa-weekly.yml.
#
# An ios or android session drives the app through the Maestro gate (mcp-maestro.json) and needs QA_DEVICE_ID,
# QA_WEBVIEW_LOG and QA_BACKEND_LOG, both logs outside the session dir. Its gate log is <out-dir>/<session>.gate.log.
# `canary` must pass before any native session runs. QA_DRY_RUN=1 prints the native claude command and
# its hook settings instead of running them.
#
# In CI c7's second browser can write anywhere in the checkout, so nothing the session runs may come from it. `harness`
# puts the compiled gate and hook, the browser's MCP server, the session's MCP config and a copy of this script in a
# dir outside the checkout, which the workflow makes read-only. `<dir>/explore.sh canary|run` with QA_HARNESS=<dir>
# and QA_REPO=<checkout> then uses them, and `run` leaves the summary to a later step without the key.

set -euo pipefail
cd "${QA_REPO:-$(dirname "$0")/../../..}"

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

# The shared prefix comes first and is identical for every session, so sessions can reuse its prompt cache.
prompt() {
  # Platform ids have no hyphen, so the last part of a session id names the platform and the rest the charter.
  local viewport driver base=${1%-*} id=${1##*-}
  viewport=$(platform "$id" viewport)
  driver=$(platform "$id" driver)
  local block blocks=(".github/qa/drivers/$driver.md")
  # c7's second device is a browser on every platform.
  if [ "$driver" != playwright ] && [ "$base" = c7-two-devices ]; then blocks+=(.github/qa/drivers/playwright.md); fi
  cat .github/qa/prompt.md
  for block in "${blocks[@]}"; do printf '\n' && cat "$block"; done
  # The model's "random" addresses repeat across sessions, so each run gets its own.
  # shellcheck disable=SC2016 # the backticks are Markdown
  printf '\n## Your run\n\n- Charter id: `%s`\n- Platform: `%s`, screen: %s.\n- Output directory: `%s/%s`\n- Fresh addresses: `qa-%s-%s-<n>@thunderbolt.test`, n = 1, 2, 3…\n\n' \
    "$1" "$id" "$viewport" "$2" "$1" "$1" "$(date +%s)"
  if [[ $1 == free-* ]]; then
    local case_id
    case_id=$(journey "${base#free-}")
    printf '## Your case (free session)\n\n```json\n'
    jq --arg id "$case_id" '.[] | select(.id == $id) | del(.pt)' .github/qa/journeys.json
    printf '```\n'
    return
  fi
  cat ".github/qa/charters/$base.md"
  printf '\n## Functions to test\n\nEach id, then the outcome that shows the function works.\n\n'
  # shellcheck disable=SC2016 # jq string interpolation
  jq --raw-output --arg charter "$base" \
    '.[$charter][] | "- `\(.id)`: \(.outcome)\(if .reload then " (after a reload)" else "" end)"' .github/qa/functions.json
}

# A native session's claude on the session dir $2, its output stream in $3, the prompt and the model's
# flags after that. The model gets the gated Maestro tools (and c7's second browser) and Write inside the session dir,
# and the hook checks every call first. The hook settings are the only user settings, in an otherwise empty config
# dir. The scrubbed CLI ignores --permission-mode, so there is none. It runs from the repo root, where the relative
# path in mcp-maestro.json points.
native_claude() {
  local session=$1 dir=$2 stream=$3 config hook log parent
  shift 3
  # The browser tools can write anywhere in the checkout, which on the Mac breaks the rule that the model writes only inside the session dir.
  if [ "$session" = c7-two-devices-ios ]; then
    echo "c7-two-devices-ios does not run: no second browser on the Mac" >&2
    exit 2
  fi
  : "${QA_DEVICE_ID:?}" "${QA_WEBVIEW_LOG:?}" "${QA_BACKEND_LOG:?}"
  # The gate and the replay trust these logs, and the model can write anywhere in the session dir. The parent is
  # resolved, so a log that does not exist yet is checked too.
  for log in "$QA_WEBVIEW_LOG" "$QA_BACKEND_LOG"; do
    parent=$(cd "$(dirname "$log")" && pwd -P)
    case $parent/ in "$dir"/*) echo "$log must be outside $dir" >&2; exit 1 ;; esac
  done
  local mcp=(.github/qa/mcp-maestro.json) allowed=("mcp__maestro__*" "Edit(/$dir/**)")
  local denied=(Bash mcp__maestro__list_devices mcp__maestro__open_maestro_viewer)
  QA_ALLOW_BROWSER_B=0
  if [ "$session" = c7-two-devices-android ]; then
    mcp+=(.github/qa/mcp-two-devices.json)
    allowed+=("mcp__playwright_b__*")
    denied+=(mcp__playwright_b__browser_run_code_unsafe)
    QA_ALLOW_BROWSER_B=1
  fi
  if [ -n "${QA_HARNESS:-}" ]; then mcp=("$QA_HARNESS/mcp.json"); fi
  export QA_ALLOW_BROWSER_B QA_PLATFORM=${session##*-} QA_SESSION_DIR=$dir QA_GATE_LOG=$dir.gate.log \
    QA_OUT=${dir%/*} QA_CHARTER=${dir##*/}
  config=$(mktemp -d)
  # Claude Code lets a call through when its hook cannot run, so a hook that crashes must still deny.
  hook="bun $(printf %q "$PWD/.github/qa/scripts/native-hook.ts") || exit 2"
  # With a harness every path below is absolute, and claude, the hook and the gate start in an empty dir: a process
  # reads files from where it starts (Bun its bunfig.toml, the browser's MCP its workspace), never the checkout.
  local cwd=$PWD
  if [ -n "${QA_HARNESS:-}" ]; then
    hook="$(printf %q "$QA_HARNESS/native-hook") || exit 2"
    cwd=$(mktemp -d)
  fi
  jq --null-input --arg command "$hook" \
    '{hooks: {PreToolUse: [{matcher: "*", hooks: [{type: "command", command: $command}]}]}}' > "$config/settings.json"
  local command=(env CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 "CLAUDE_CONFIG_DIR=$config" claude -p "$@"
    --setting-sources user
    --tools Write
    --allowedTools "${allowed[@]}"
    --disallowedTools "${denied[@]}"
    --strict-mcp-config --mcp-config "${mcp[@]}"
    --output-format stream-json --verbose --no-session-persistence)
  if [ "${QA_DRY_RUN:-}" = 1 ]; then
    printf '%s\0' "${command[@]}" | jq --raw-input --slurp --argjson settings "$(cat "$config/settings.json")" \
      --arg cwd "$cwd" \
      '{command: split("\u0000")[:-1], settings: $settings, cwd: $cwd, env: ($ENV | with_entries(select(.key | startswith("QA_"))))}'
  else
    (cd "$cwd" && exec "${command[@]}") < /dev/null > "$stream" || true
  fi
  rm -rf "$config"
  if [ "$cwd" != "$PWD" ]; then rm -rf "$cwd"; fi
}

# A native session's output dir as an absolute path without links, so the Edit rule, the hook and the paths in the
# prompt all name the same folder.
real_out() {
  mkdir -p "$1/$2"
  (cd "$1" && pwd -P)
}

# The metrics and the coverage input from a finished session's stream ($3).
summarize() {
  local session=$1 out=$2 dir=$2/$1
  jq --slurp . "$3" > "$dir/execution.json"
  jq --compact-output --from-file .github/qa/transcript.jq "$dir/execution.json" > "$dir/transcript.json"
  bun .github/qa/scripts/report.ts session --execution-file "$dir/execution.json" --charter "$session" --out "$out"
  cat "$dir/session.json"
}

run() {
  local session=$1 out=$2 dir=$2/$1 config text
  if [ "$(platform "${session##*-}" driver)" = maestro ]; then
    out=$(real_out "$out" "$session")
    # An assignment, so a prompt that fails to build stops the run instead of starting a session without it.
    text=$(prompt "$session" "$out")
    rm -f "$out/$session.gate.log"
    # The stream sits next to the gate log, outside the session dir the model can write to: coverage reads it.
    native_claude "$session" "$out/$session" "$out/$session.run.jsonl" "$text" \
      --model claude-sonnet-5-5 --max-budget-usd "$3" --max-turns 400
    # With a harness the checkout may have been rewritten, and this step holds the key: no repo code runs now.
    if [ "${QA_DRY_RUN:-}" != 1 ] && [ -z "${QA_HARNESS:-}" ]; then summarize "$session" "$out" "$out/$session.run.jsonl"; fi
    return
  fi
  QA_CHARTER=$session
  QA_MCP_VIEWPORT=$(platform "${session##*-}" viewport)
  : "${QA_MCP_CONFIG:=$(platform "${session##*-}" mcp)}"
  export QA_CHARTER QA_MCP_VIEWPORT QA_MCP_CONFIG
  mkdir -p "$dir"
  config=$(mktemp -d)
  # An empty config dir: no user settings, hooks, memory or login. The exit code is read from the result instead.
  # shellcheck disable=SC2086 # QA_MCP_CONFIG holds one config file per word
  QA_OUT=$out CLAUDE_CONFIG_DIR=$config claude -p "$(prompt "$session" "$out")" \
    --model claude-sonnet-5-5 \
    --setting-sources user \
    --permission-mode dontAsk \
    --tools Write \
    --allowedTools "mcp__playwright__*" "mcp__playwright_b__*" "Edit($out/**)" \
    --disallowedTools mcp__playwright__browser_run_code_unsafe mcp__playwright_b__browser_run_code_unsafe \
    --strict-mcp-config --mcp-config $QA_MCP_CONFIG \
    --max-budget-usd "${3:-2}" --max-turns 400 \
    --output-format stream-json --verbose --no-session-persistence < /dev/null > "$dir/run.jsonl" || true
  rm -rf "$config"
  summarize "$session" "$out" "$dir/run.jsonl"
}

# One cheap session before any native session: it asks for a script through the gate and a write outside
# the session dir, with the session's own settings. It passes only when the gate log shows the hook letting the run
# through, the gate denying it and the hook denying the write, and the file does not exist. It prints the session's
# result line and never a tool result.
canary() {
  local session=$1 out outside=/tmp/qa-canary-outside.txt dir
  [ "$(platform "${session##*-}" driver)" = maestro ] || { echo "the canary is for native sessions" >&2; exit 2; }
  out=$(real_out "$2" "canary-$1")
  dir=$out/canary-$session
  rm -f "$outside" "$dir.gate.log"
  native_claude "$session" "$dir" "$dir/run.jsonl" \
    "Call the Maestro run tool with the yaml \`- runScript: canary.js\`, and use Write to create $outside with the
text canary. Make both calls in your first turn, even if one of them fails, then stop." \
    --model claude-haiku-5-5 --max-turns 4 --max-budget-usd 0.05
  if [ "${QA_DRY_RUN:-}" = 1 ]; then return; fi
  jq --raw-input --compact-output 'fromjson? | select(.type == "result") | {subtype, is_error, num_turns}' \
    "$dir/run.jsonl"
  # The hook's own line for the Maestro call proves it runs on MCP calls too, not only on Write.
  if grep -qs '^allow mcp__maestro__run ' "$dir.gate.log" && grep -qs '^deny run ' "$dir.gate.log" &&
    grep -qs '^deny Write ' "$dir.gate.log" && [ ! -e "$outside" ]; then
    echo "canary denied"
    return
  fi
  echo "canary NOT denied: no native session may run" >&2
  exit 1
}

# The gate and the hook as standalone binaries that read nothing from the checkout or node_modules, this script, and
# the session's MCP config pointing at them. c7 on Android also gets its own install of the second browser's MCP
# server and the layout probe, so npx resolves nothing in the checkout.
harness() {
  local session=$1 dir=$2 servers
  mkdir -p "$dir"
  dir=$(cd "$dir" && pwd -P)
  # A compiled binary reads bunfig.toml (a preload is code) and .env from where it starts unless told not to.
  local build=(bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv
    --no-compile-autoload-tsconfig --no-compile-autoload-package-json)
  "${build[@]}" .github/qa/scripts/maestro-gate.ts --outfile "$dir/maestro-gate" >&2
  "${build[@]}" .github/qa/scripts/native-hook.ts --outfile "$dir/native-hook" >&2
  cp .github/qa/scripts/explore.sh "$dir/explore.sh"
  servers=$(jq --null-input --arg gate "$dir/maestro-gate" '{maestro: {type: "stdio", command: $gate, args: []}}')
  if [ "$session" = c7-two-devices-android ]; then
    cp .github/qa/layout-probe.js "$dir/layout-probe.js"
    # args[1] is the pinned package, args[0] npx's -y.
    npm install --silent --prefix "$dir/playwright-mcp" \
      "$(jq --raw-output '.mcpServers.playwright_b.args[1]' .github/qa/mcp-two-devices.json)" >&2
    # shellcheck disable=SC2016 # jq variables
    servers=$(jq --argjson servers "$servers" --arg bin "$dir/playwright-mcp/node_modules/.bin/playwright-mcp" \
      --arg probe "$dir/layout-probe.js" '$servers + {playwright_b: (.mcpServers.playwright_b | .command = $bin
        | .args = (.args[2:] | map(if . == ".github/qa/layout-probe.js" then $probe else . end)))}' \
      .github/qa/mcp-two-devices.json)
  fi
  jq --null-input --argjson servers "$servers" '{mcpServers: $servers}' > "$dir/mcp.json"
}

case "${1:-}" in
  prompt) prompt "$2" "$3" ;;
  run) run "$2" "$3" "${4:-2}" ;;
  canary) canary "$2" "$3" ;;
  journey) journey "${2:-}" ;;
  harness) harness "$2" "$3" ;;
  *)
    echo "usage: $0 prompt <session> <out-dir> | run <session> <out-dir> [max-usd] | canary <session> <out-dir> |" \
      "journey [<case>] | harness <session> <dir>" >&2
    exit 2
    ;;
esac
