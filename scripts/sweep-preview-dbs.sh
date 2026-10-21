#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# -----------------------------------------------------------------------------
# sweep-preview-dbs.sh
# -----------------------------------------------------------------------------
# Drops every per-PR database on the shared preview Postgres whose PR is not in
# the keep list: `preview_pr_<n>`, `preview_pr_<n>_ps_storage` and the PowerSync
# replication slots inside them, plus the retired shared PowerSync's
# `powersync_storage` and any inactive slot it left in `postgres`.
#
# `drop-preview-db.sh` drops a PR's databases at teardown; this catches whatever
# escapes it, so leaked slots never pile up against `max_replication_slots`.
# Preview Cleanup runs it hourly with the open PRs and live preview stacks as
# the keep list.
#
# The Postgres sits in a private subnet, so the SQL runs in a one-off ECS task
# derived from the shared Postgres task definition, whose image has psql and
# which already receives POSTGRES_PASSWORD.
#
# Usage: sweep-preview-dbs.sh <PR_NUMBER>...   (the PRs to keep)
# Env:   DRY_RUN=true lists what would be dropped without dropping it.
# Requires: AWS creds with ECS + Logs perms; AWS_REGION set (default us-east-1).
# -----------------------------------------------------------------------------

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
DRY_RUN="${DRY_RUN:-false}"
SHARED_CLUSTER_PREFIX="tb-previews-shared-cluster-"
PG_SVC_PREFIX="tb-previews-shared-pg-svc-"

log() { echo "[sweep-preview-dbs] $*"; }

# An empty keep list would drop every preview's database.
if [ "$#" -eq 0 ]; then
  log "ERROR: no PRs to keep given; refusing to sweep."
  exit 1
fi
for pr in "$@"; do
  [[ "$pr" =~ ^[0-9]+$ ]] || { log "ERROR: not a PR number: $pr"; exit 1; }
done
KEEP_PRS="$*"

# First ARN in field $1 of an AWS CLI JSON listing that contains $2, or nothing.
# See drop-preview-db.sh for why the listings use `--output json`.
first_arn() {
  jq -r --arg field "$1" --arg match "$2" '[.[$field][] | select(contains($match))][0] // empty'
}

CLUSTER=$(aws ecs list-clusters --region "$AWS_REGION" --output json | first_arn clusterArns "$SHARED_CLUSTER_PREFIX")
if [ -z "$CLUSTER" ]; then
  log "No shared cluster found — nothing to sweep."
  exit 0
fi

PG_SVC=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" --output json | first_arn serviceArns "$PG_SVC_PREFIX")
if [ -z "$PG_SVC" ]; then
  log "No shared Postgres service found — nothing to sweep."
  exit 0
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

aws ecs describe-services --cluster "$CLUSTER" --services "$PG_SVC" --region "$AWS_REGION" \
  --query 'services[0]' --output json > "$WORKDIR/service.json"
aws ecs describe-task-definition --task-definition "$(jq -r .taskDefinition "$WORKDIR/service.json")" \
  --region "$AWS_REGION" --query 'taskDefinition' > "$WORKDIR/source.json"

# Runs in the postgres image's busybox sh. Database names come from a regex
# match, so they are safe to interpolate. The lists are assigned before looping
# because `set -e` ignores a failing command substitution in a `for` word list,
# which would let an unreachable Postgres exit 0 having swept nothing.
SWEEP_CMD=$(cat <<'EOF'
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD" PGHOST=postgres.thunderbolt.local PGUSER=postgres PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -tAc "$1"; }
failed=0
dbs=$(q "SELECT datname FROM pg_database WHERE datname ~ '^preview_pr_[0-9]+(_ps_storage)?\$' OR datname = 'powersync_storage' ORDER BY 1")
slots=$(q "SELECT slot_name FROM pg_replication_slots WHERE database = 'postgres' AND NOT active")
for db in $dbs; do
  pr=$(echo "$db" | sed -n 's/^preview_pr_\([0-9]*\).*/\1/p')
  if [ -n "$pr" ] && echo " $KEEP_PRS " | grep -q " $pr "; then
    echo "keep $db"
    continue
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "would drop $db"
    continue
  fi
  echo "dropping $db"
  q "SELECT pg_terminate_backend(active_pid, 5000) FROM pg_replication_slots WHERE database = '$db' AND active_pid IS NOT NULL" > /dev/null &&
    q "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = '$db'" > /dev/null &&
    q "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" > /dev/null ||
    { echo "failed to drop $db"; failed=1; }
done
for slot in $slots; do
  if [ "$DRY_RUN" = true ]; then
    echo "would drop slot $slot"
    continue
  fi
  echo "dropping slot $slot"
  q "SELECT pg_drop_replication_slot('$slot')" > /dev/null || { echo "failed to drop slot $slot"; failed=1; }
done
exit "$failed"
EOF
)

jq --arg cmd "$SWEEP_CMD" --arg keep "$KEEP_PRS" --arg dry "$DRY_RUN" '
  {taskRoleArn, executionRoleArn, networkMode, requiresCompatibilities, family: "tb-previews-shared-db-sweep", cpu: "256", memory: "512",
   containerDefinitions: [.containerDefinitions[0]
     | del(.mountPoints, .portMappings, .stopTimeout)
     | .name = "db-sweep"
     | .entryPoint = ["sh", "-c"]
     | .command = [$cmd]
     | .environment = [{name: "KEEP_PRS", value: $keep}, {name: "DRY_RUN", value: $dry}]
     | .logConfiguration.options["awslogs-stream-prefix"] = "db-sweep"]}
' "$WORKDIR/source.json" > "$WORKDIR/sweep-taskdef.json"

SWEEP_TASKDEF=$(aws ecs register-task-definition --cli-input-json "file://$WORKDIR/sweep-taskdef.json" --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
log "Registered sweep task def: $SWEEP_TASKDEF (keep: $KEEP_PRS, dry run: $DRY_RUN)"

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$SWEEP_TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "$(jq -c .networkConfiguration "$WORKDIR/service.json")" \
  --started-by "preview-db-sweep" \
  --region "$AWS_REGION" \
  --query 'tasks[0].taskArn' --output text)
log "Sweep task started: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)
log "Sweep task exit code: $EXIT_CODE"

LOG_GROUP=$(jq -r '.containerDefinitions[0].logConfiguration.options."awslogs-group"' "$WORKDIR/source.json")
log "--- task logs ---"
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "db-sweep/db-sweep/${TASK_ARN##*/}" \
  --start-from-head --limit 200 --region "$AWS_REGION" \
  --query 'events[].message' --output text || log "(no logs available)"

aws ecs deregister-task-definition --task-definition "$SWEEP_TASKDEF" --region "$AWS_REGION" > /dev/null
log "Deregistered sweep task def"

if [ "$EXIT_CODE" != "0" ]; then
  log "ERROR: sweep task exited with code $EXIT_CODE"
  exit 1
fi
