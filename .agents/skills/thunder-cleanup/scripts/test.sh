#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Self-test for record.sh and inventory.sh. Creates a throwaway worktree and branch under a
# temp dir, records a fake scratch dir, checks the inventory lists exactly those items, runs
# the removal commands it printed, and verifies everything is gone. The guards are checked with
# fake inputs; nothing outside the temp dir and the throwaway branch is deleted.
# Usage: bash test.sh               removal commands run in bash
#        CLEANUP_SHELL=zsh bash test.sh   removal commands run in zsh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=$(git -C "$repo" worktree list --porcelain | awk 'NR == 1 { print substr($0, 10) }')
tmp=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/thunder-cleanup-test.XXXXXX")" && pwd -P)
branch="thunder-cleanup-selftest/$$" # the slash checks branch names with directories
wt="$tmp/wt"
wt2="$tmp/wt2"
scratch="$tmp/scratch"
cleanup_shell=${CLEANUP_SHELL:-bash}
ledgers='' # every ledger file this test created
sleepers=''

fail() { echo "FAIL: $*" >&2; exit 1; }
refused() { [ -n "$(bash "$here/record.sh" --refuse "$1" "$wt")" ] || fail "guard allowed $1"; }
allowed() { [ -z "$(bash "$here/record.sh" --refuse "$1" "$wt")" ] || fail "guard refused $1: $(bash "$here/record.sh" --refuse "$1" "$wt")"; }
cleanup() {
  for p in $sleepers; do kill "$p" 2>/dev/null || true; done
  for w in "$wt" "$wt2"; do git -C "$repo" worktree remove --force "$w" 2>/dev/null || true; done
  for b in "$branch" "$branch-renamed" "$branch-gone" "$branch-new"; do git -C "$repo" branch -q -D "$b" 2>/dev/null || true; done
  for l in $ledgers; do rm -f "$l"; done
  rm -rf "$tmp"
}
trap cleanup EXIT
command -v "$cleanup_shell" > /dev/null || fail "$cleanup_shell is not installed"

git -C "$repo" worktree add -q -b "$branch" "$wt" HEAD
mkdir -p "$scratch"
echo data > "$scratch/file"
inv() { (export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; "$@"); }
rec() { (cd "$1" && bash "$here/record.sh" "$2" "$3" selftest) > /dev/null; ledgers="$ledgers $(bash "$here/record.sh" --ledger "$1")"; }
# Run every owned row's command except prune (it also clears other already-deleted worktrees).
remove_owned() {
  local status kind id cmd
  while IFS=$'\t' read -r status kind id _ _ cmd; do
    [ "$status" = owned ] && [ -n "$cmd" ] && [ "$kind" != prune ] || continue
    (cd "$tmp" && "$cleanup_shell" -c "$cmd") > /dev/null 2>&1 || fail "removal failed in $cleanup_shell for $kind $id: $cmd"
  done <<< "$1"
}

# 1. Path guard: physical resolution, temp dir or task worktree only, never around or inside a checkout.
for p in "$HOME/" // / "$main/.." "$HOME/.claude/projects" "$HOME/.argent" "$HOME/.bun" "$main" "$main/node_modules" \
  "$repo/node_modules" "$wt" "$tmp" "$(dirname "$main")" relative/dir; do refused "$p"; done
allowed "$scratch"
allowed "$wt/node_modules"
if (cd "$wt" && bash "$here/record.sh" scratch "$HOME" selftest) 2>/dev/null; then fail 'record.sh recorded HOME as scratch'; fi

# 6. Simulator and AVD ids.
for v in all Booted '' 'A-B'; do
  if bash "$here/record.sh" --valid ios-simulator "$v"; then fail "simulator id '$v' accepted"; fi
done
bash "$here/record.sh" --valid ios-simulator 0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0 || fail 'valid UDID refused'
for v in ../x -rf '.hidden' 'a b'; do
  if bash "$here/record.sh" --valid android-avd "$v"; then fail "AVD name '$v' accepted"; fi
done
bash "$here/record.sh" --valid android-avd Pixel_8_API_35 || fail 'valid AVD name refused'

# 7. Pids: never 1 or below, never this process chain, group kill only for a group leader.
for v in 0 1 -1 12a; do
  if bash "$here/record.sh" --valid pid "$v"; then fail "pid '$v' accepted"; fi
done
sleep 60 & same_group=$!
set -m; sleep 60 & own_group=$!; set +m
sleepers="$same_group $own_group"
self_pgid=$(ps -o pgid= -p $$ | tr -d ' ')
kc() { (export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; self_pids=$$; self_pgids=" $self_pgid "; kill_command "$1"); }
[ -z "$(kc 1)" ] || fail 'kill command for pid 1'
[ -z "$(kc $$)" ] || fail 'kill command for this shell'
[ "$(kc "$same_group")" = "kill -TERM $same_group" ] || fail "pid in this shell's group got: $(kc "$same_group")"
[ "$(kc "$own_group")" = "kill -TERM -- -$own_group" ] || fail "group leader got: $(kc "$own_group")"
"$cleanup_shell" -c "$(kc "$own_group")" || fail "$cleanup_shell rejected the group kill"
"$cleanup_shell" -c "$(kc "$same_group")" || fail "$cleanup_shell rejected the single kill"

# 4. PR matching: skip forks, verify the head against local history, refuse the default branch.
tip=$(git -C "$wt" rev-parse HEAD)
empty_tree=$(git -C "$wt" hash-object -w -t tree /dev/null)
unrelated=$(git -C "$wt" commit-tree "$empty_tree" -m 'thunder-cleanup selftest: unrelated commit')
pick() { printf '%b' "$1" | inv pick_pr "$branch"; }
[ "$(pick "1\tMERGED\tu1\t$tip\ttrue\n2\tOPEN\tu2\t$tip\tfalse\n" | cut -f1,2)" = "2	OPEN" ] || fail 'fork PR not skipped'
[ "$(pick "3\tMERGED\tu3\t$tip\tfalse\n" | cut -f2)" = MERGED ] || fail 'matching PR not verified'
[ "$(pick "4\tMERGED\tu4\t$unrelated\tfalse\n" | cut -f2)" = MERGED-UNVERIFIED ] || fail 'unrelated PR head accepted'
[ "$(pick "5\tMERGED\tu5\t0000000000000000000000000000000000000001\tfalse\n" | cut -f2)" = MERGED-UNVERIFIED ] || fail 'unknown PR head accepted'
[ -z "$(pick "6\tMERGED\tu6\t$tip\ttrue\n")" ] || fail 'fork-only PR list produced a PR'
if (cd "$tmp" && bash "$here/inventory.sh" main) > /dev/null 2>&1; then fail 'inventory accepted the default branch'; fi

# 3 and 9. Compose ownership and nested worktrees, from fake inputs.
[ -z "$(export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; roots="$wt"; compose_dirs=$(printf 'p1\t%s\n' "$wt/powersync-service"); outside_dirs p1)" ] ||
  fail 'project with all containers inside was refused'
[ "$(export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; roots="$wt"; compose_dirs=$(printf 'p2\t%s\np2\t/elsewhere\n' "$wt/a"); outside_dirs p2)" = /elsewhere ] ||
  fail 'shared compose project was claimed'
[ -n "$(export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; worktrees=$(printf '%s\tb\n%s\tc\n' "$wt" "$wt/nested"); nested_worktrees "$wt")" ] ||
  fail 'nested worktree not detected'
(export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; roots="$wt"$'\n'
  is_task_default_project "$(default_project "$wt")") || fail "the task's Makefile default project was not claimable"
if (export THUNDER_CLEANUP_SOURCE=1; set +e; source "$here/inventory.sh"; roots="$wt"$'\n'; is_task_default_project powersync-service); then
  fail 'a direct-compose project name (powersync-service) was claimable'
fi

# 5. The docker removal command: one call per id, nothing on empty input, any failure is a
#    non-zero exit, in bash and zsh.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" << 'STUB'
#!/bin/sh
case "$2" in
  ls) [ -z "$STUB_IDS" ] || printf '%s\n' $STUB_IDS; exit "${STUB_LS_RC:-0}" ;;
  rm) echo "$*" >> "$STUB_LOG"; exit "${STUB_RM_RC:-0}" ;;
esac
STUB
chmod +x "$tmp/bin/docker"
docker_cmd=$(inv docker_rm_command selftest-project)
stub() { : > "$tmp/stub.log"; PATH="$tmp/bin:$PATH" STUB_LOG="$tmp/stub.log" "$@" -c "$docker_cmd"; }
for sh in bash zsh; do
  command -v "$sh" > /dev/null || continue
  STUB_IDS='id1 id2' stub "$sh" || fail "$sh: docker removal failed with a working docker"
  [ "$(wc -l < "$tmp/stub.log" | tr -d ' ')" = 8 ] || fail "$sh: expected 8 docker rm calls, got: $(cat "$tmp/stub.log")"
  STUB_IDS='' stub "$sh" || fail "$sh: docker removal failed on empty input"
  [ ! -s "$tmp/stub.log" ] || fail "$sh: docker rm ran on empty input"
  if STUB_IDS='id1 id2' STUB_RM_RC=1 stub "$sh"; then fail "$sh: a failing docker rm exited 0"; fi
  if STUB_IDS='id1' STUB_LS_RC=1 stub "$sh"; then fail "$sh: a failing docker ls exited 0"; fi
done

# Recording, then 8: a branch rename keeps the ledger.
if (cd "$wt" && bash "$here/record.sh" bogus x selftest) 2>/dev/null; then fail 'record.sh accepted an unknown kind'; fi
git -C "$wt" checkout -q --detach
if (cd "$wt" && bash "$here/record.sh" scratch "$scratch" selftest) 2>/dev/null; then fail 'record.sh accepted a detached HEAD'; fi
git -C "$wt" checkout -q "$branch"
[ -z "$(bash "$here/record.sh" --ledger "$wt")" ] || fail 'a checkout with no records already has a ledger'
rec "$wt" scratch "$scratch"
ledger=$(bash "$here/record.sh" --ledger "$wt")
[ -f "$ledger" ] || fail "ledger missing at $ledger"
git -C "$wt" branch -q -m "$branch" "$branch-renamed"
branch="$branch-renamed"
[ "$(bash "$here/record.sh" --ledger "$wt")" = "$ledger" ] || fail 'branch rename changed the ledger'

# 2 and 6 at inventory level: a refused snapshot adds no discovery roots; a bad simulator id stays manual.
printf 'snapshot\t%s\tselftest\t%s\t%s\n' "$main" "$branch" "$wt" >> "$ledger"
printf 'ios-simulator\tall\tselftest\t%s\t%s\n' "$branch" "$wt" >> "$ledger"
printf 'pid\t1\tselftest\t%s\t%s\n' "$branch" "$wt" >> "$ledger"

out=$(cd "$tmp" && bash "$here/inventory.sh" "$wt")
claimed=$(awk -F'\t' '$1 == "owned" || $1 == "probable" { print $1 "\t" $2 "\t" $3 }' <<< "$out")
expected=$(printf '%s\n' "owned	scratch	$scratch" "owned	worktree	$wt" "owned	branch	$branch" "owned	prune	-")
[ "$(sort <<< "$claimed")" = "$(sort <<< "$expected")" ] ||
  fail "inventory claimed a different set of items:"$'\n'"$claimed"$'\n'"expected:"$'\n'"$expected"
for k in snapshot ios-simulator process; do
  awk -F'\t' -v k="$k" '$1 == "manual" && $2 == k' <<< "$out" | grep -q . || fail "no manual $k row for the refused ledger value"
done
! grep -q 'simctl delete all' <<< "$out" || fail 'inventory printed simctl delete all'
grep -qF "info	ledger	$ledger" <<< "$out" || fail 'ledger not kept while manual rows remain'

remove_owned "$out"
[ ! -e "$wt" ] || fail 'worktree still on disk'
[ ! -e "$scratch" ] || fail 'scratch dir still on disk'
[ -f "$ledger" ] || fail 'ledger removed while manual rows remain'
rm -f "$ledger" # its remaining rows are this test's fake values
! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" || fail 'branch still exists'
! git -C "$repo" worktree list --porcelain | grep -qxF "worktree $wt" || fail 'worktree still registered'

# New 1: a worktree removed outside thunder-cleanup leaves its ledger; branch mode still finds the
# rows, and a new worktree at the same path starts a fresh ledger instead of inheriting them.
branch=${branch%-renamed}
mkdir -p "$tmp/scratch-gone" "$tmp/scratch-new"
git -C "$repo" worktree add -q -b "$branch-gone" "$wt2" HEAD
rec "$wt2" scratch "$tmp/scratch-gone"
old_ledger=$(bash "$here/record.sh" --ledger "$wt2")
git -C "$repo" worktree remove --force "$wt2"
git -C "$repo" worktree add -q -b "$branch-new" "$wt2" HEAD
rec "$wt2" scratch "$tmp/scratch-new"
[ "$(bash "$here/record.sh" --ledger "$wt2")" != "$old_ledger" ] || fail 'a new worktree at the same path inherited the old ledger'
out=$(cd "$tmp" && bash "$here/inventory.sh" "$wt2")
! grep -qF "$tmp/scratch-gone" <<< "$out" || fail 'the new worktree claimed the old worktree scratch'
grep -qF "owned	scratch	$tmp/scratch-new" <<< "$out" || fail 'the new worktree lost its own scratch'
gone=$(cd "$tmp" && bash "$here/inventory.sh" "$branch-gone")
grep -qF "owned	scratch	$tmp/scratch-gone" <<< "$gone" || fail 'branch mode missed the removed worktree ledger rows'
remove_owned "$gone"
[ ! -e "$tmp/scratch-gone" ] || fail 'removed-worktree scratch still on disk'
[ ! -f "$old_ledger" ] || fail 'emptied ledger of the removed worktree still present'
remove_owned "$out"
[ ! -e "$wt2" ] && [ ! -e "$tmp/scratch-new" ] || fail 'second worktree or its scratch still on disk'
echo "thunder-cleanup self-test passed (removal commands in $cleanup_shell)"
