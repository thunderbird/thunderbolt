/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { normalizeEmail } from '@/lib/email'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const personalWorkspaceName = 'Personal'

/**
 * Bootstraps a new real user's workspace state in a single transaction:
 *
 *   1. Insert the user's personal workspace (`is_personal = true`, `owner_user_id = userId`).
 *   2. Insert an `admin` membership row linking the user to that workspace.
 *   3. Promote any pending memberships matching `normalizedEmail` into real memberships
 *      and delete the pending rows.
 *
 * Idempotent across signup retries via the partial-unique index
 * `idx_workspaces_personal_per_owner` and the unique index on
 * `(workspace_id, user_id)` — `ON CONFLICT DO NOTHING` makes a re-run a no-op rather
 * than failing the user-create hook.
 *
 * Called from the Better Auth post-user-create hook. Skipped for anonymous users
 * (Decision 12 — anonymous personal workspaces are FE-created).
 */
export const bootstrapUserWorkspace = async (database: typeof DbType, userId: string, email: string): Promise<void> => {
  const normalizedEmail = normalizeEmail(email)

  await database.transaction(async (tx) => {
    const txDb = tx as unknown as typeof database

    // Resolve-or-create. The partial unique index `idx_workspaces_personal_per_owner`
    // enforces one personal workspace per owner, but `onConflictDoNothing` can't target
    // a partial index — so check first, then insert. Both reads happen inside the tx so
    // a concurrent signup retry can't double-insert.
    const existing = await txDb
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(and(eq(workspacesTable.ownerUserId, userId), eq(workspacesTable.isPersonal, true)))
      .limit(1)

    const personalWorkspaceId = existing[0]?.id ?? uuidv7()

    if (!existing[0]) {
      await txDb.insert(workspacesTable).values({
        id: personalWorkspaceId,
        name: personalWorkspaceName,
        isPersonal: true,
        ownerUserId: userId,
      })
    }

    await txDb
      .insert(workspaceMembershipsTable)
      .values({
        id: uuidv7(),
        workspaceId: personalWorkspaceId,
        userId,
        role: 'admin',
      })
      .onConflictDoNothing({
        target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      })

    const pending = await txDb
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, normalizedEmail))

    if (pending.length === 0) {
      return
    }

    await txDb
      .insert(workspaceMembershipsTable)
      .values(
        pending.map((row) => ({
          id: uuidv7(),
          workspaceId: row.workspaceId,
          userId,
          role: row.role,
        })),
      )
      .onConflictDoNothing({
        target: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId],
      })

    await txDb
      .delete(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, normalizedEmail))
  })
}
