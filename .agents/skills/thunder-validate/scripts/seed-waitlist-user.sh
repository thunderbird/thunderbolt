#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail
# Input: disposable email and local Docker target. Output: email only. Side effect: approved waitlist UPSERT.
usage() {
  cat <<'HELP'
Usage: bash seed-waitlist-user.sh --email EMAIL (--compose-project NAME | --container NAME) [--repo PATH]
Approve a disposable LOCAL test account idempotently in public.waitlist.
Uses postgres service with powersync-service/docker-compose.yml, or an explicit container.
Reads POSTGRES_USER/POSTGRES_DB inside the container (defaults postgres); prints email only.
Does not create schema, install dependencies, or access a remote database. Check the current schema first.
HELP
}
email='';project='';container='';repo="$PWD"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --email|--compose-project|--container|--repo)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      case "$1" in
        --email) email=$2 ;; --compose-project) project=$2 ;; --container) container=$2 ;; --repo) repo=$2 ;;
      esac
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$email" ]] && [[ "$email" != *$'\n'* ]] && [[ "$email" == *@*.* ]] || { echo 'Provide a disposable test email via --email.' >&2; exit 2; }
[[ -n "$project" && -z "$container" || -z "$project" && -n "$container" ]] || { echo 'Choose exactly one local Docker target: --compose-project or --container.' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker CLI missing; start the local Docker stack first.' >&2; exit 2; }
if [[ -n "$project" ]]; then
  [[ -f "$repo/powersync-service/docker-compose.yml" ]] || { echo 'Use --repo with a Thunderbolt checkout.' >&2; exit 2; }
  runner=(docker compose -f "$repo/powersync-service/docker-compose.yml" -p "$project" exec -T postgres)
else
  runner=(docker exec -i "$container")
fi
# psql quotes :'email' as a SQL literal; no interpolation into SQL or shell code.
if ! "${runner[@]}" sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" "$@"' sh -v "email=$email" >/dev/null <<'SQL'
INSERT INTO public.waitlist (id, email, status, created_at, updated_at)
VALUES ('validation-' || md5(lower(:'email')), lower(:'email'), 'approved', now(), now())
ON CONFLICT (email) DO UPDATE SET status = 'approved', updated_at = now();
SQL
then
  echo 'Approval failed. Check Docker daemon, selected local postgres container, and applied waitlist migrations.' >&2
  exit 1
fi
printf '%s\n' "$email"
