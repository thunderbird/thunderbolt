#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Read-only inventory of everything a finished task left on this machine.
# Usage: inventory.sh <worktree-path | branch>    one task
#        inventory.sh --merged                    every worktree whose newest same-repo PR is merged
# Prints one tab-separated row per item: status, kind, id, size, proof, removal command.
# status: owned (ledger or structural), probable (discovery only, confirm), manual, info.
# It never deletes anything; the commands run in bash or zsh, for the caller to run after
# confirmation. THUNDER_CLEANUP_SOURCE=1 loads the functions without running (for test.sh).
set -uo pipefail # no -e: discovery probes fail routinely and must not stop the inventory

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
record="$here/record.sh"
main=$(git -C "$here" worktree list --porcelain | awk 'NR == 1 { print substr($0, 10) }')
worktrees=$(git -C "$main" worktree list --porcelain | awk '
  /^worktree / { p = substr($0, 10) }
  /^branch /   { b = substr($0, 8); sub(/^refs\/heads\//, "", b); print p "\t" b }
  /^detached/  { print p "\t" }')

q() { printf '%q' "$1"; }
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
kb_of() { du -sk "$1" 2>/dev/null | awk '{ print $1 }'; }
human() {
  case "$1" in '' | *[!0-9]*) echo '-' ; return ;; esac
  awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1fG", k / 1048576; else if (k >= 1024) printf "%.0fM", k / 1024; else printf "%dK", k }'
}
physical() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
inside() { case "$1" in "$2" | "$2"/*) return 0 ;; esac; return 1; }
refuse_reason() { bash "$record" --refuse "$1" "${2:-}"; }
valid() { bash "$record" --valid "$1" "$2"; }

total_kb=0
manual_rows=0
row() { # status kind id size_kb proof command
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(human "$4")" "$5" "$6"
  case "$1" in owned | probable) case "$4" in '' | *[!0-9]*) ;; *) total_kb=$((total_kb + $4)) ;; esac ;; esac
  [ "$1" != manual ] || manual_rows=$((manual_rows + 1))
}

roots='' # newline-separated paths (raw and physical) whose contents belong to the task
others='' # other registered worktrees inside those roots; their contents belong to their own task
add_root() { roots="$roots$1"$'\n'"$(physical "$1")"$'\n'; }
under_roots() {
  local r
  while IFS= read -r r; do
    [ -n "$r" ] && inside "$1" "$r" && return 1
  done <<< "$others"
  while IFS= read -r r; do
    [ -n "$r" ] && inside "$1" "$r" && return 0
  done <<< "$roots"
  return 1
}

is_default_branch() {
  local d
  d=$(git -C "$main" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  [ "$1" = main ] || [ "$1" = master ] || [ "$1" = "${d#origin/}" ]
}

# Machine-wide probes, collected once.
probe_machine() {
  local p=$$
  self_pids=$$
  while p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ') && [ -n "$p" ] && [ "$p" -gt 1 ]; do self_pids="$self_pids $p"; done
  self_pgids=$(for p in $self_pids; do ps -o pgid= -p "$p" 2>/dev/null | tr -d ' '; done | sort -u | tr '\n' ' ')
  proc_cwds=$(lsof -a -d cwd -Fpn 2>/dev/null | awk '/^p/ { pid = substr($0, 2) } /^n/ { print pid "\t" substr($0, 2) }')
  docker_ok=false
  compose_dirs=''
  if command -v docker >/dev/null 2>&1 && with_timeout 20 docker info >/dev/null 2>&1; then
    docker_ok=true
    compose_dirs=$(with_timeout 30 docker ps -a --filter label=com.docker.compose.project \
      --format '{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)
  fi
  derived=''
  local dd_root="$HOME/Library/Developer/Xcode/DerivedData" plist
  if [ -d "$dd_root" ] && command -v plutil >/dev/null 2>&1; then
    for plist in "$dd_root"/*/info.plist; do
      [ -f "$plist" ] || continue
      derived="$derived$(dirname "$plist")"$'\t'"$(plutil -extract WorkspacePath raw -o - "$plist" 2>/dev/null)"$'\n'
    done
  fi
}

# PRs whose head branch has this name, newest first: number, state, url, head oid, isCrossRepository.
pr_lines() { (cd "$main" && gh pr list --head "$1" --state all -L 20 --json number,state,url,headRefOid,isCrossRepository \
  --jq '.[] | [.number, .state, .url, .headRefOid, .isCrossRepository] | @tsv' 2>/dev/null); }

# Newest same-repo PR from pr_lines on stdin. Its state gets "-UNVERIFIED" unless its head and
# the local branch tip lie on one line of history (a reused branch name matches other work).
pick_pr() { # branch
  local n s u oid cross tip="refs/heads/$1"
  while IFS=$'\t' read -r n s u oid cross; do
    [ -n "$n" ] && [ "$cross" = false ] || continue
    if git -C "$main" cat-file -e "$oid^{commit}" 2>/dev/null &&
      { git -C "$main" merge-base --is-ancestor "$oid" "$tip" 2>/dev/null ||
        git -C "$main" merge-base --is-ancestor "$tip" "$oid" 2>/dev/null; }; then
      printf '%s\t%s\t%s\t%s\n' "$n" "$s" "$u" "$oid"
    else
      printf '%s\t%s-UNVERIFIED\t%s\t%s\n' "$n" "$s" "$u" "$oid"
    fi
    return
  done
}

# Makefile default COMPOSE_PROJECT_NAME for a checkout path: <parent>-<dir>, sanitized.
default_project() {
  local parent base
  parent=$(basename "$(dirname "$1")" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
  base=$(basename "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
  echo "$parent-$base"
}

# Container working_dirs of a compose project that lie outside the task's roots, comma-separated.
outside_dirs() {
  awk -F'\t' -v p="$1" '$1 == p { print $2 }' <<< "$compose_dirs" |
    while IFS= read -r d; do under_roots "$d" || echo "${d:-<no working_dir label>}"; done | sort -u | paste -sd, -
}

# Removal command for one compose project: one docker call per id, safe on empty input, in bash
# and zsh, exiting non-zero when any listing or removal failed.
docker_rm_command() {
  local f t out='cleanup_failed=0; '
  f=$(q "label=com.docker.compose.project=$1")
  for t in 'container ls -aq|container rm -f' 'volume ls -q|volume rm -f' 'network ls -q|network rm' 'image ls -q|image rm -f'; do
    out="$out"'ids=$(docker '"${t%%|*} --filter $f"') || cleanup_failed=1; printf "%s\n" "$ids" | sort -u | '
    out="$out"'( rc=0; while read -r id; do [ -z "$id" ] || docker '"${t#*|}"' "$id" < /dev/null || rc=1; done; exit $rc ) || cleanup_failed=1; '
  done
  printf '%s' "$out"'[ "$cleanup_failed" = 0 ]'
}

# Discovered projects are claimed only under the Makefile's default COMPOSE_PROJECT_NAME for a task
# root; any other name (e.g. `powersync-service` from a direct compose up) may share volumes with
# another checkout.
is_task_default_project() {
  local r
  while IFS= read -r r; do
    [ -n "$r" ] && [ "$(default_project "$r")" = "$1" ] && return 0
  done <<< "$roots"
  return 1
}

compose_row() { # status project proof [quiet: no row when nothing is left]
  local f="label=com.docker.compose.project=$2" c v n i out
  out=$(outside_dirs "$2")
  if [ -n "$out" ]; then row manual compose-project "$2" - "$3; also has containers outside this task: $out" ''; return; fi
  c=$(with_timeout 20 docker ps -aq --filter "$f" | wc -l | tr -d ' ')
  v=$(with_timeout 20 docker volume ls -q --filter "$f" | wc -l | tr -d ' ')
  n=$(with_timeout 20 docker network ls -q --filter "$f" | wc -l | tr -d ' ')
  i=$(with_timeout 20 docker image ls -q --filter "$f" | sort -u | wc -l | tr -d ' ')
  if [ $((c + v + n + i)) -eq 0 ]; then [ -n "${4:-}" ] || row info compose-project "$2" - "$3; nothing left" ''; return; fi
  row "$1" compose-project "$2" - "$3; containers=$c volumes=$v networks=$n images=$i" "$(docker_rm_command "$2")"
}

# Kill command for a recorded pid, or nothing when it must be left alone: pid 1 and below,
# this agent's own process chain. A group leader outside this agent's groups is stopped with its group.
kill_command() {
  local pid=$1 pgid
  valid pid "$pid" || return 0
  case " $self_pids " in *" $pid "*) return 0 ;; esac
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ "$pgid" = "$pid" ] && case " $self_pgids " in *" $pgid "*) false ;; *) true ;; esac; then
    echo "kill -TERM -- -$pid"
  else
    echo "kill -TERM $pid"
  fi
}

# Other worktrees that sit inside this one, comma-separated (git worktree remove would take them).
nested_worktrees() {
  local wt_p o
  wt_p=$(physical "$1")
  while IFS=$'\t' read -r o _; do
    [ -n "$o" ] || continue
    [ "$(physical "$o")" != "$wt_p" ] && inside "$(physical "$o")" "$wt_p" && echo "$o"
  done <<< "$worktrees" | paste -sd, -
}

# Other registered worktrees inside the task's roots, so their processes and caches stay out.
collect_others() { # task worktree (may be empty)
  local o
  others=''
  while IFS=$'\t' read -r o _; do
    [ -n "$o" ] && [ "$(physical "$o")" != "$(physical "${1:-/nonexistent}")" ] && under_roots "$o" &&
      others="$others$o"$'\n'"$(physical "$o")"$'\n'
  done <<< "$worktrees"
}

inventory_task() { # worktree-path (may be empty) branch
  local wt=$1 branch=$2 own='' ledgers='' entries='' e f mode pr kind value skill pid cwd cmd seen='' project dir wp path rel reason nested
  local pr_number pr_state pr_url pr_oid='' skipped=0 up
  # The worktree's own ledger, plus this branch's rows in every other ledger: a worktree removed
  # outside thunder-cleanup leaves its ledger behind under an id nothing points at any more.
  # shortcut: rows recorded under a branch's old name are found only through the worktree's own ledger, so they are missed once that worktree is gone.
  [ -n "$wt" ] && own=$(bash "$record" --ledger "$wt")
  for f in "$(git -C "$main" rev-parse --path-format=absolute --git-common-dir)"/thunder-resources/*.tsv; do
    [ -f "$f" ] || continue
    if [ "$f" = "$own" ]; then e=$(cut -f1-4 "$f"); mode=own; else e=$(awk -F'\t' -v b="$branch" '$4 == b' "$f" | cut -f1-4); mode=rows; fi
    [ -n "$e" ] || continue
    entries="$entries$e"$'\n'
    ledgers="$ledgers$f"$'\t'"$mode"$'\n'
  done
  entries=$(printf '%s' "$entries" | sort -u)
  roots=''
  total_kb=0
  manual_rows=0
  [ -n "$wt" ] && add_root "$wt"
  while IFS=$'\t' read -r kind value skill _; do
    [ "$kind" = snapshot ] && [ -z "$(refuse_reason "$value" "$wt")" ] && add_root "$value"
  done <<< "$entries"
  collect_others "$wt"

  printf '# task\tbranch=%s\tworktree=%s\tmain=%s\n' "$branch" "${wt:-none}" "$main"
  printf 'status\tkind\tid\tsize\tproof\tcommand\n'

  pr=$(pr_lines "$branch" | pick_pr "$branch")
  if [ -n "$pr" ]; then
    IFS=$'\t' read -r pr_number pr_state pr_url pr_oid <<< "$pr"
    row info pr "#$pr_number" - "$pr_state $pr_url" ''
  else
    row info pr none - "no same-repo PR found for $branch (gh missing, offline, or never opened)" ''
  fi

  [ -n "$wt" ] && row info uncommitted "$(git -C "$wt" status --porcelain | wc -l | tr -d ' ') files" - 'git status --porcelain' ''
  # Commits live on the branch, so check it even when its worktree is already gone.
  if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
    up=$(git -C "$main" for-each-ref --format='%(upstream)' "refs/heads/$branch")
    if [ -n "$up" ] && git -C "$main" show-ref --verify --quiet "$up"; then
      row info unpushed "$(git -C "$main" rev-list --count "$up..refs/heads/$branch") commits" - 'ahead of upstream' ''
    elif [ -n "$pr_oid" ] && git -C "$main" cat-file -e "$pr_oid^{commit}" 2>/dev/null; then
      row info unpushed "$(git -C "$main" rev-list --count "$pr_oid..refs/heads/$branch") commits" - 'ahead of the PR head (upstream is gone)' ''
    else
      row info unpushed unknown - 'no upstream and no local copy of the PR head; compare by hand' ''
    fi
  fi

  # 1. Processes: ledger pids first, then anything whose cwd is inside the task's roots.
  while IFS=$'\t' read -r kind value skill _; do
    [ "$kind" = pid ] || continue
    seen="$seen $value"
    cmd=$(kill_command "$value")
    if [ -z "$cmd" ]; then row manual process "$value" - "ledger ($skill); refused: pid 1 or below, or this agent's own process" ''; continue; fi
    path=$(ps -o command= -p "$value" 2>/dev/null | cut -c1-80)
    if [ -z "$path" ]; then row info process "$value" - "ledger ($skill); not running" ''; continue; fi
    cwd=$(awk -F'\t' -v p="$value" '$1 == p { print $2 }' <<< "$proc_cwds")
    row probable process "$value" - "ledger ($skill), pid may be reused: now '$path' in ${cwd:-?}" "$cmd"
  done <<< "$entries"
  while IFS=$'\t' read -r pid cwd; do
    [ -n "$pid" ] && under_roots "$cwd" || continue
    case " $self_pids $seen " in *" $pid "*) continue ;; esac
    # Direct children of this agent's own process chain are its tools (MCP bridges, helper shells).
    case " $self_pids " in *" $(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') "*) skipped=$((skipped + 1)); continue ;; esac
    row probable process "$pid" - "cwd $cwd: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80)" "kill -TERM $pid"
  done <<< "$proc_cwds"
  [ "$skipped" -eq 0 ] || row info process "$skipped skipped" - "tools of the agent running this inventory; stop what you started yourself" ''

  # 2. Docker compose projects: ledger, or the Makefile default name of a task root. A project is
  #    claimed only when every one of its containers runs from inside the task.
  if [ "$docker_ok" = true ]; then
    seen=''
    while IFS=$'\t' read -r kind value skill _; do
      [ "$kind" = compose-project ] || continue
      case " $seen " in *" $value "*) continue ;; esac
      seen="$seen $value"
      if valid compose-project "$value"; then compose_row owned "$value" "ledger ($skill)"; else
        row manual compose-project "$value" - "ledger ($skill); refused: invalid project name" ''; fi
    done <<< "$entries"
    while IFS=$'\t' read -r project dir; do
      [ -n "$project" ] && under_roots "$dir" || continue
      case " $seen " in *" $project "*) continue ;; esac
      is_task_default_project "$project" && continue # claimed by the default-name pass below
      seen="$seen $project"
      row manual compose-project "$project" - "containers run from $dir, but the name is neither recorded nor this task's Makefile default, so its volumes may belong to another checkout" ''
    done <<< "$compose_dirs"
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      project=$(default_project "$path")
      case " $seen " in *" $project "*) continue ;; esac
      seen="$seen $project"
      # shortcut: with no containers left, a name match can collide with another repo's <parent>-<dir>; it stays probable so the user confirms.
      compose_row probable "$project" "Makefile default COMPOSE_PROJECT_NAME for $path" quiet
    done <<< "$(printf '%s\n' "$roots" | awk 'NF && !s[$0]++')"
  else
    row manual docker - - 'docker unreachable from this machine; rerun the inventory when it answers' ''
  fi

  # 3. Simulators and emulators the task created (ledger only; pre-existing devices are never listed).
  while IFS=$'\t' read -r kind value skill _; do
    case "$kind" in ios-simulator | android-avd) ;; *) continue ;; esac
    if ! valid "$kind" "$value"; then row manual "$kind" "$value" - "ledger ($skill); refused: not a valid $kind id" ''; continue; fi
    if [ "$kind" = ios-simulator ]; then
      # grep without -q: an early exit would SIGPIPE simctl and fail the pipeline under pipefail.
      if command -v xcrun >/dev/null 2>&1 && xcrun simctl list devices 2>/dev/null | grep -F "($value)" > /dev/null; then
        row owned ios-simulator "$value" "$(kb_of "$HOME/Library/Developer/CoreSimulator/Devices/$value")" "ledger ($skill)" \
          "xcrun simctl shutdown $value 2>/dev/null; xcrun simctl delete $value"
      else
        row manual ios-simulator "$value" - "ledger ($skill); not on this machine" "on the Mac that has it: xcrun simctl delete $value"
      fi
    else
      dir=${ANDROID_AVD_HOME:-$HOME/.android/avd}
      if [ -d "$dir/$value.avd" ]; then
        row owned android-avd "$value" "$(kb_of "$dir/$value.avd")" "ledger ($skill)" "rm -rf $(q "$dir/$value.avd") $(q "$dir/$value.ini")"
      else
        row manual android-avd "$value" - "ledger ($skill); not on this machine" "where the emulator runs: avdmanager delete avd -n $value"
      fi
    fi
  done <<< "$entries"

  # 4. Build caches outside the tree: Xcode DerivedData whose workspace sits in the task's roots.
  while IFS=$'\t' read -r dir wp; do
    [ -n "$dir" ] && [ -n "$wp" ] && under_roots "$wp" || continue
    row probable derived-data "$dir" "$(kb_of "$dir")" "info.plist WorkspacePath $wp" "rm -rf $(q "$dir")"
  done <<< "$derived"

  # 5. Snapshot and scratch directories from the ledger, each behind the path guard.
  while IFS=$'\t' read -r kind value skill _; do
    case "$kind" in snapshot | scratch) ;; *) continue ;; esac
    if [ ! -e "$value" ]; then row info "$kind" "$value" - "ledger ($skill); already gone" ''; continue; fi
    reason=$(refuse_reason "$value" "$wt")
    if [ -n "$reason" ]; then row manual "$kind" "$value" "$(kb_of "$value")" "ledger ($skill); refused: $reason" ''; continue; fi
    row owned "$kind" "$value" "$(kb_of "$value")" "ledger ($skill)" "rm -rf $(q "$value")"
  done <<< "$entries"

  # 6. The worktree itself, with its heaviest ignored parts for the report.
  if [ -n "$wt" ]; then
    nested=$(nested_worktrees "$wt")
    if [ -n "$nested" ]; then
      row manual worktree "$wt" "$(kb_of "$wt")" "contains other worktrees: $nested; clean those first" ''
    else
      row owned worktree "$wt" "$(kb_of "$wt")" 'git worktree list' "cd $(q "$main") && git worktree remove $(q "$wt")"
    fi
    for rel in node_modules backend/node_modules src-tauri/target dist test-results playwright-report e2e/test-results \
      src-tauri/gen/android/.gradle src-tauri/gen/android/app/build src-tauri/gen/apple/build qa-out-* qa-dist-*; do
      for path in "$wt"/$rel; do [ -e "$path" ] && row info worktree-part "${path#"$wt"/}" "$(kb_of "$path")" 'inside the worktree' ''; done
    done
  fi

  # 7. Git leftovers: stashes made on the branch, the branch, stale worktree entries, the ledger.
  while IFS=$'\t' read -r value cmd; do
    case "$cmd" in "On $branch: "* | "WIP on $branch: "*) ;; *) continue ;; esac
    row probable stash "$value" - "$cmd" \
      "ref=\$(git -C $(q "$main") stash list --format='%gd %H' | awk '\$2 == \"$value\" { print \$1 }'); [ -n \"\$ref\" ] && git -C $(q "$main") stash drop \"\$ref\""
  done <<< "$(git -C "$main" stash list --format='%H%x09%gs' 2>/dev/null)"
  if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
    row owned branch "$branch" - 'local branch; delete only after gh confirms the PR merged' "git -C $(q "$main") branch -D $(q "$branch")"
  fi
  if with_timeout 20 git -C "$main" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    row info remote-branch "origin/$branch" - 'still on origin; left alone (merged branches are deleted by GitHub)' ''
  fi
  row owned prune - - 'stale worktree entries' "git -C $(q "$main") worktree prune"
  while IFS=$'\t' read -r f mode; do
    [ -n "$f" ] || continue
    # The ledger is the only record of what is left, so keep it while any manual row stays unresolved.
    if [ "$manual_rows" -gt 0 ]; then
      row info ledger "$f" - "kept: $manual_rows manual row(s) still unresolved" ''
    elif [ "$mode" = own ]; then
      row owned ledger "$f" "$(kb_of "$f")" 'thunder-resources ledger of this worktree' "rm -f $(q "$f")"
    else
      row owned ledger "$f" - "this branch's rows in another ledger" \
        "awk -F'\t' -v b=$(q "$branch") '\$4 != b' $(q "$f") > $(q "$f.tmp") && mv $(q "$f.tmp") $(q "$f") && { [ -s $(q "$f") ] || rm -f $(q "$f"); }"
    fi
  done <<< "$ledgers"
  printf '# total\t%s\t(owned + probable)\n\n' "$(human "$total_kb")"
}

run() {
  local wt branch
  case "${1:-}" in
    '' | -h | --help) sed -n '7,13p' "${BASH_SOURCE[0]}"; exit 2 ;;
    --merged)
      probe_machine
      while IFS=$'\t' read -r wt branch; do
        [ -n "$wt" ] && [ "$wt" != "$main" ] || continue
        [ -n "$branch" ] || { printf '# skipped\t%s\tdetached HEAD\n' "$wt"; continue; }
        is_default_branch "$branch" && { printf '# skipped\t%s\ton the default branch\n' "$wt"; continue; }
        [ "$(pr_lines "$branch" | pick_pr "$branch" | cut -f2)" = MERGED ] && inventory_task "$wt" "$branch"
      done <<< "$worktrees" ;;
    *)
      if [ -d "$1" ]; then
        wt=$(git -C "$1" rev-parse --show-toplevel) || exit 1
        branch=$(git -C "$wt" branch --show-current)
        [ -n "$branch" ] || { echo "inventory.sh: $wt has a detached HEAD; pass the branch name instead" >&2; exit 1; }
        awk -F'\t' '{ print $1 }' <<< "$worktrees" | while IFS= read -r p; do physical "$p"; echo; done |
          grep -xF "$(physical "$wt")" > /dev/null || { echo "inventory.sh: $wt is not a worktree of $main" >&2; exit 1; }
      else
        branch=$1
        wt=$(awk -F'\t' -v b="$branch" '$2 == b { print $1; exit }' <<< "$worktrees")
      fi
      if is_default_branch "$branch"; then echo "inventory.sh: refusing the default branch '$branch'" >&2; exit 1; fi
      if [ "$(physical "${wt:-/nonexistent}")" = "$(physical "$main")" ]; then
        printf '# note\t%s is checked out in the main checkout; switch it first: git -C %s switch main\n' "$branch" "$(q "$main")"
        wt=''
      fi
      probe_machine
      inventory_task "$wt" "$branch" ;;
  esac
}

[ "${THUNDER_CLEANUP_SOURCE:-}" = 1 ] || run "$@"
