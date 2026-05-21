#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# -----------------------------------------------------------------------------
# drop-preview-db.sh
# -----------------------------------------------------------------------------
# Drops the per-stack logical Postgres database for a PR preview environment.
#
# The shared-postgres preview model (THU-495) gives each PR its own logical DB
# (e.g. `preview_pr_851`) on a single shared Postgres instance. Pulumi destroy
# tears down ECS/ALB/secrets but does not drop the logical DB, so schema state
# (notably `__drizzle_migrations` content hashes) leaks across destroy/deploy
# cycles and causes drizzle-kit to fail on the next deploy when migrations
# have been re-edited.
#
# This script runs as part of `Preview Destroy` *before* `pulumi destroy`,
# while the per-stack secrets and backend task definition still exist. It
# registers a one-off task definition derived from the backend's, overrides
# the entryPoint to bypass the migrate-on-boot logic, and invokes a tiny
# DROP DATABASE against `POSTGRES_ADMIN_URL`.
#
# Usage: drop-preview-db.sh <PR_NUMBER>
# Requires: AWS creds with ECS + Logs perms; AWS_REGION set (default us-east-1).
#
# Idempotent: if the stack's resources are already gone, exits 0 with a note.
# -----------------------------------------------------------------------------

set -euo pipefail

PR_NUMBER="${1:?PR number required}"
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="preview-pr-${PR_NUMBER}"
BACKEND_FAMILY="tb-${STACK}-backend"
BE_SVC_PREFIX="tb-${STACK}-be-svc-"
SHARED_CLUSTER_PREFIX="tb-previews-shared-cluster-"

log() { echo "[drop-preview-db] $*"; }

CLUSTER=$(aws ecs list-clusters --region "$AWS_REGION" \
  --query "clusterArns[?contains(@, '${SHARED_CLUSTER_PREFIX}')] | [0]" --output text)
if [ -z "$CLUSTER" ] || [ "$CLUSTER" = "None" ]; then
  log "No shared cluster found — nothing to drop."
  exit 0
fi

SVC=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" \
  --query "serviceArns[?contains(@, '${BE_SVC_PREFIX}')] | [0]" --output text)
if [ -z "$SVC" ] || [ "$SVC" = "None" ]; then
  log "No backend service for ${STACK} — stack already torn down or never deployed. Skipping."
  exit 0
fi

TASKDEF=$(aws ecs list-task-definitions --family-prefix "$BACKEND_FAMILY" --status ACTIVE --region "$AWS_REGION" \
  --query 'taskDefinitionArns | [-1]' --output text)
if [ -z "$TASKDEF" ] || [ "$TASKDEF" = "None" ]; then
  log "No backend task definition for ${STACK} — skipping."
  exit 0
fi

NETCONF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$AWS_REGION" \
  --query 'services[0].networkConfiguration' --output json)

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

aws ecs describe-task-definition --task-definition "$TASKDEF" --region "$AWS_REGION" \
  --query 'taskDefinition' > "$WORKDIR/source.json"

DROP_CMD='bun -e '\''import postgres from "postgres"; const target = new URL(process.env.DATABASE_URL); const dbName = target.pathname.replace(/^\//, ""); if (!/^[a-zA-Z0-9_]+$/.test(dbName)) { console.error("refusing drop on invalid name:", dbName); process.exit(1); } const admin = postgres(process.env.POSTGRES_ADMIN_URL); console.log("dropping", dbName); await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); await admin.end(); console.log("done")'\'

jq --arg cmd "$DROP_CMD" --arg family "tb-${STACK}-db-drop" '
  {containerDefinitions, family: $family, taskRoleArn, executionRoleArn, networkMode, requiresCompatibilities, cpu, memory}
  | .containerDefinitions[0].entryPoint = ["sh", "-c"]
  | .containerDefinitions[0].command = [$cmd]
' "$WORKDIR/source.json" > "$WORKDIR/drop-taskdef.json"

DROP_TASKDEF=$(aws ecs register-task-definition --cli-input-json "file://$WORKDIR/drop-taskdef.json" --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
log "Registered drop task def: $DROP_TASKDEF"

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$DROP_TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "$NETCONF" \
  --started-by "preview-destroy-pr-${PR_NUMBER}" \
  --region "$AWS_REGION" \
  --query 'tasks[0].taskArn' --output text)
log "Drop task started: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$AWS_REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)
log "Drop task exit code: $EXIT_CODE"

TASK_ID="${TASK_ARN##*/}"
LOG_GROUP=$(jq -r '.containerDefinitions[0].logConfiguration.options."awslogs-group"' "$WORKDIR/source.json")
LOG_PREFIX=$(jq -r '.containerDefinitions[0].logConfiguration.options."awslogs-stream-prefix"' "$WORKDIR/source.json")
CONTAINER_NAME=$(jq -r '.containerDefinitions[0].name' "$WORKDIR/source.json")
log "--- task logs ---"
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "${LOG_PREFIX}/${CONTAINER_NAME}/${TASK_ID}" \
  --start-from-head --limit 50 --region "$AWS_REGION" \
  --query 'events[].message' --output text || log "(no logs available)"

aws ecs deregister-task-definition --task-definition "$DROP_TASKDEF" --region "$AWS_REGION" >/dev/null
log "Deregistered drop task def"

if [ "$EXIT_CODE" != "0" ]; then
  log "ERROR: drop task exited with code $EXIT_CODE"
  exit 1
fi

log "Per-stack database for ${STACK} dropped successfully"
