/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { alwaysEncryptedTables, encryptedColumnsMap, isEncryptionEnabled } from './config'
import { codec } from './codec'

type CrudOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/**
 * @todo Temporary scope: until the E2EE pipeline supports multi-recipient
 * envelopes per workspace (THU-593), workspace-scoped collaborative resources
 * (models, prompts, skills, modes, model_profiles, triggers, `workspaces.name`)
 * are encrypted only when the row lives in the active user's personal
 * workspace; their shared-workspace counterparts travel as plaintext so other
 * members can read them. Per-user-only tables (see `alwaysEncryptedTables`) and
 * per-account tables without a `workspace_id` column (settings, devices) stay
 * encrypted regardless. When workspace-aware E2EE lands, this scope check goes
 * away and the encoder reverts to encrypting every row of every
 * encrypted-column table.
 *
 * The `workspaces` table is special: the row IS the workspace, so we read
 * `is_personal` from the row data rather than `workspace_id`.
 */
const isRowInPersonalScope = (op: CrudOperation, personalWorkspaceId: string | null): boolean => {
  if (alwaysEncryptedTables.has(op.type)) {
    return true
  }
  if (op.type === 'workspaces') {
    const flag = op.data?.is_personal
    if (flag === 1 || flag === true) {
      return true
    }
    return personalWorkspaceId !== null && op.id === personalWorkspaceId
  }
  const workspaceId = op.data?.workspace_id
  if (typeof workspaceId !== 'string') {
    return true
  }
  return personalWorkspaceId !== null && workspaceId === personalWorkspaceId
}

/**
 * Encrypts encrypted columns in a CRUD operation before upload.
 * Returns the operation unchanged if the table has no encrypted columns,
 * the op is DELETE, or the row is not in the personal-workspace scope.
 *
 * `personalWorkspaceId` is the active user's personal-workspace id (resolved
 * by the caller via `getPersonalWorkspaceId`). Pass `null` when it can't be
 * resolved — in that case only tables without `workspace_id` (settings,
 * devices) are still encrypted; workspace-scoped rows go plaintext until the
 * personal workspace is seeded.
 */
export const encodeForUpload = async (
  operation: CrudOperation,
  personalWorkspaceId: string | null = null,
): Promise<CrudOperation> => {
  if (!isEncryptionEnabled() || operation.op === 'DELETE' || !operation.data) {
    return operation
  }

  const columns = encryptedColumnsMap[operation.type]
  if (!columns) {
    return operation
  }

  if (!isRowInPersonalScope(operation, personalWorkspaceId)) {
    return operation
  }

  const encodedData = { ...operation.data }
  await Promise.all(
    columns.map(async (col) => {
      const value = encodedData[col]
      if (typeof value === 'string') {
        encodedData[col] = await codec.encode(value)
      }
    }),
  )

  return { ...operation, data: encodedData }
}
