#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Record a resource a task created outside its checkout, so thunder-cleanup can remove it later.
# Usage (run inside the task's checkout or worktree): record.sh <kind> <value> <skill>
#   snapshot, scratch   absolute path under the temp dir or inside the task worktree
#   compose-project     compose project name
#   ios-simulator       simulator UDID
#   android-avd         AVD name
#   pid                 process id above 1 (a process group leader is stopped with its group)
# Appends "kind<TAB>value<TAB>skill<TAB>branch<TAB>worktree" to the ledger of this checkout:
# <git-common-dir>/thunder-resources/<id>.tsv, where <id> lives in the checkout's own git dir
# (thunder-cleanup-ledger-id). A branch rename keeps the id; removing the worktree deletes it,
# so a new worktree at the same path starts a fresh ledger. Helper modes used by inventory.sh:
#   record.sh --ledger <checkout>              print the ledger path (nothing before the first record)
#   record.sh --refuse <path> [<task worktree>] print why rm -rf of <path> is unsafe (empty: safe)
#   record.sh --valid <kind> <value>           exit 0 when the value is valid for the kind
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
usage='usage: record.sh <snapshot|scratch|compose-project|ios-simulator|android-avd|pid> <value> <skill>'

inside() { case "$1" in "$2" | "$2"/*) return 0 ;; esac; return 1; }

# Physical path of an existing directory, or of an existing parent plus the last component.
physical_of() {
  if [ -d "$1" ]; then (cd "$1" && pwd -P); return; fi
  local parent
  parent=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
  case "$(basename "$1")" in . | ..) return 1 ;; esac
  printf '%s/%s\n' "${parent%/}" "$(basename "$1")"
}

ledger_for() { # checkout [create]
  local gd idf
  gd=$(git -C "$1" rev-parse --absolute-git-dir) || return 1
  idf="$gd/thunder-cleanup-ledger-id"
  if ! grep -Eqx '[0-9a-f]{40}' "$idf" 2>/dev/null; then
    [ -n "${2:-}" ] || return 0
    printf '%s %s %s %s\n' "$gd" "$(date +%s)" "$$" "$RANDOM" | git hash-object --stdin > "$idf"
  fi
  printf '%s/thunder-resources/%s.tsv\n' "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)" "$(cat "$idf")"
}

# Allowed: strictly inside the temp dir or the task worktree, and never a checkout, around one,
# or inside another checkout.
refuse_reason() {
  local path=$1 wt='' p other o root
  case "$path" in /*) ;; *) echo 'not an absolute path'; return ;; esac
  p=$(physical_of "$path") || { echo 'cannot resolve the path'; return; }
  [ -n "${2:-}" ] && wt=$(cd "$2" 2>/dev/null && pwd -P)
  while IFS= read -r other; do
    o=$(physical_of "$other") || o=$other
    inside "$o" "$p" && { echo "is or contains the checkout $other"; return; }
    if inside "$p" "$o" && [ "$o" != "$wt" ] && ! { [ -n "$wt" ] && inside "$wt" "$o" && inside "$p" "$wt"; }; then
      echo "inside the checkout $other"; return
    fi
  done <<< "$(git -C "$here" worktree list --porcelain | awk '/^worktree / { print substr($0, 10) }')"
  for root in "$(physical_of "${TMPDIR:-/tmp}")" "$(physical_of /tmp)" "$wt"; do
    [ -n "$root" ] && case "$p" in "${root%/}"/?*) return ;; esac
  done
  echo 'outside the temp dir and the task worktree'
}

valid() { # kind value
  case "$1" in
    snapshot | scratch)
      case "$2" in *$'\t'* | *$'\n'*) return 1 ;; esac
      [ -z "$(refuse_reason "$2" "$(git rev-parse --show-toplevel 2>/dev/null)")" ] ;;
    pid) case "$2" in '' | *[!0-9]*) return 1 ;; esac; [ "$2" -gt 1 ] ;;
    ios-simulator) printf '%s' "$2" | grep -Eqx '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' ;;
    android-avd | compose-project) printf '%s' "$2" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._-]*' ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  --ledger) [ "$#" -eq 2 ] || { echo "$usage" >&2; exit 2; }; ledger_for "$2"; exit ;;
  --refuse) [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }; refuse_reason "$2" "${3:-}"; exit 0 ;;
  --valid) [ "$#" -eq 3 ] || { echo "$usage" >&2; exit 2; }; valid "$2" "$3"; exit ;;
esac

[ "$#" -eq 3 ] || { echo "$usage" >&2; exit 2; }
kind=$1 value=$2 skill=$3
case "$kind" in snapshot | scratch | compose-project | ios-simulator | android-avd | pid) ;; *)
  echo "record.sh: unknown kind '$kind'" >&2; echo "$usage" >&2; exit 2 ;;
esac
case "$skill" in '' | *[[:space:]]*) echo 'record.sh: skill must be one word' >&2; exit 2 ;; esac
if ! valid "$kind" "$value"; then
  reason=''
  case "$kind" in snapshot | scratch) reason=": $(refuse_reason "$value" "$(git rev-parse --show-toplevel 2>/dev/null)")" ;; esac
  echo "record.sh: invalid $kind '$value'$reason" >&2
  exit 2
fi

branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "record.sh: detached HEAD, no branch to record against; check out the task branch first" >&2; exit 1; }
top=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
ledger=$(ledger_for "$top" create)
mkdir -p "$(dirname "$ledger")"
printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$value" "$skill" "$branch" "$top" >> "$ledger"
echo "recorded $kind $value in $ledger"
