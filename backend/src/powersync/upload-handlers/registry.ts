/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { type PowerSyncTableName } from '@shared/powersync-tables'
import { createUserScopedHandler } from './user-scoped'
import { createWorkspaceScopedHandler } from './workspace-scoped'
import { UploadRejection, type RejectedOp, type UploadCtx, type UploadHandler, type UploadOp } from './types'
import { workspacesHandler } from './workspaces'
import { workspaceMembershipsHandler } from './workspace-memberships'
import { workspacePendingMembershipsHandler } from './workspace-pending-memberships'
import { workspacePermissionsHandler } from './workspace-permissions'

/**
 * Per-table upload handler registry. The `Record<PowerSyncTableName, …>` shape
 * is the schema-drift pin (addendum §3.9): adding a new synced table to
 * `shared/powersync-tables.ts` without a matching handler here fails `tsc`.
 *
 * The user-scoped factory covers tables whose rows are owned by a single user;
 * the workspace tables have bespoke handlers because their permission model is
 * row-relational rather than row-owned.
 */
export const handlers: Record<PowerSyncTableName, UploadHandler> = {
  // Account-level (user-scoped, not workspace-scoped).
  settings: createUserScopedHandler({ tableName: 'settings' }),
  // Devices are partially writable: server-managed columns are stripped, DELETE
  // goes through the dedicated revoke API (`/api/account/devices/:id`).
  devices: createUserScopedHandler({
    tableName: 'devices',
    denyColumns: ['revoked_at', 'trusted', 'public_key', 'mlkem_public_key', 'approval_pending', 'app_version'],
    denyDelete: true,
  }),

  // Workspace-scoped, user-private (only the row's author may read/write).
  chat_threads: createWorkspaceScopedHandler({ tableName: 'chat_threads', userPrivate: true }),
  chat_messages: createWorkspaceScopedHandler({ tableName: 'chat_messages', userPrivate: true }),
  tasks: createWorkspaceScopedHandler({ tableName: 'tasks', userPrivate: true }),

  // Workspace-scoped, shared (any member of the workspace may read/write).
  models: createWorkspaceScopedHandler({
    tableName: 'models',
    userPrivate: false,
    addPermissionKey: 'add_models',
    removePermissionKey: 'remove_models',
    softDeleteColumn: 'deleted_at',
  }),
  mcp_servers: createWorkspaceScopedHandler({
    tableName: 'mcp_servers',
    userPrivate: false,
    addPermissionKey: 'add_mcp_servers',
    removePermissionKey: 'remove_mcp_servers',
    softDeleteColumn: 'deleted_at',
  }),
  prompts: createWorkspaceScopedHandler({ tableName: 'prompts', userPrivate: false }),
  skills: createWorkspaceScopedHandler({
    tableName: 'skills',
    userPrivate: false,
    addPermissionKey: 'add_skills',
    removePermissionKey: 'remove_skills',
    softDeleteColumn: 'deleted_at',
  }),
  triggers: createWorkspaceScopedHandler({ tableName: 'triggers', userPrivate: false }),
  modes: createWorkspaceScopedHandler({ tableName: 'modes', userPrivate: false }),
  model_profiles: createWorkspaceScopedHandler({ tableName: 'model_profiles', userPrivate: false }),
  agents: createWorkspaceScopedHandler({
    tableName: 'agents',
    userPrivate: false,
    addPermissionKey: 'add_agents',
    removePermissionKey: 'remove_agents',
    softDeleteColumn: 'deleted_at',
  }),

  // Workspace registry tables — bespoke handlers (commit 2).
  workspaces: workspacesHandler,
  workspace_memberships: workspaceMembershipsHandler,
  workspace_pending_memberships: workspacePendingMembershipsHandler,
  workspace_permissions: workspacePermissionsHandler,
}

export type BatchResult =
  /**
   * The batch completed without any transient failures. Applied ops are committed;
   * `rejected` lists every op that was permanently rejected (its savepoint rolled
   * back individually so it never landed in the DB). Empty list = full success.
   */
  | { ok: true; rejected: RejectedOp[] }
  /**
   * At least one op (or the outer transaction itself) hit a transient failure;
   * the entire batch rolled back. The caller maps this to a 5xx so PowerSync
   * retries the batch.
   */
  | { ok: false; code: string; op?: UploadOp }

/**
 * Runs the upload batch with per-op savepoints inside a single outer transaction.
 *
 * - Permanent rejection → that op's savepoint is rolled back; the op is added to
 *   the `rejected` list and the loop continues. Earlier applied ops remain visible
 *   to later ops (last-admin protection still observes cumulative state).
 * - Transient rejection (or any non-`UploadRejection` throw) → bubble out of the
 *   outer transaction, rolling everything back. Caller returns 5xx so PowerSync
 *   retries the batch.
 *
 * Per the addendum's failure classification (§3.9): permanent = ack-reject and
 * discard, transient = retry. The all-or-nothing tx around the batch keeps
 * cross-op invariants atomic; per-op savepoints let permanent rejections coexist
 * with applied ops in the same response.
 */
export const applyUploadBatch = async (
  database: typeof DbType,
  operations: UploadOp[],
  ctx: UploadCtx,
): Promise<BatchResult> => {
  const rejected: RejectedOp[] = []
  // Mutated inside the async tx callback — TS won't narrow across that boundary,
  // so the outer catch reads these fields directly.
  let transientOp: UploadOp | null = null
  let transientCode: string | null = null

  const recordPermanent = (op: UploadOp, code: string): void => {
    rejected.push({ op, code })
  }

  try {
    await database.transaction(async (outerTx) => {
      const outerDb = outerTx as unknown as typeof database

      for (const op of operations) {
        const handler = handlers[op.type]
        if (!handler) {
          recordPermanent(op, 'UNKNOWN_TABLE')
          continue
        }

        try {
          // Nested transaction uses a Postgres savepoint; rolling back the inner
          // throw doesn't abort the outer tx. See Drizzle's transaction docs.
          await outerDb.transaction(async (innerTx) => {
            const innerDb = innerTx as unknown as typeof database
            const result = await handler.validate(op, ctx, innerDb)
            if (result.kind === 'reject') {
              throw new UploadRejection(result.class, result.code)
            }
            await handler.apply(op, ctx, innerDb)
          })
        } catch (err) {
          if (err instanceof UploadRejection && err.rejectionClass === 'permanent') {
            recordPermanent(op, err.code)
            continue
          }
          // Either a transient UploadRejection or an uncategorized error (raw DB
          // failure, deadlock, etc.) — abort the whole batch so PowerSync retries.
          transientOp = op
          transientCode =
            err instanceof UploadRejection ? err.code : err instanceof Error ? err.message : 'UNKNOWN_ERROR'
          throw err
        }
      }
    })
  } catch (err) {
    if (transientOp && transientCode) {
      return { ok: false, code: transientCode, op: transientOp }
    }
    // Outer tx itself failed (commit error, connection drop, etc.) — surface as transient.
    return {
      ok: false,
      code: err instanceof Error ? err.message : 'UNKNOWN_ERROR',
    }
  }

  return { ok: true, rejected }
}
