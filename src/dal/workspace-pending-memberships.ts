/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspacePendingMembershipsTable } from '../db/tables'

export type WorkspacePendingMembership = {
  id: string
  workspaceId: string
  email: string
  role: 'admin' | 'member'
  invitedByUserId: string
  createdAt: string | null
}

export const getPendingByWorkspace = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
): Promise<WorkspacePendingMembership[]> => {
  const rows = await db
    .select()
    .from(workspacePendingMembershipsTable)
    .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    .all()
  return rows as WorkspacePendingMembership[]
}
