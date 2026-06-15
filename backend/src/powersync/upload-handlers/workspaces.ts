/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getWorkspaceById,
  insertPersonalWorkspaceIfMissing,
  isAdminOfAnyWorkspace,
  isWorkspaceAdmin,
  updateWorkspace,
  upsertWorkspace,
} from '@/dal/workspaces'
import { computePersonalWorkspaceId } from '@shared/workspaces'
import { allow, reject } from './helpers'
import { UploadRejection, type UploadHandler } from './types'

/**
 * Upload handler for the `workspaces` table. Enforces:
 *
 * - **Personal workspace PUT**: allowed iff the row id matches the canonical
 *   `computePersonalWorkspaceId(ctx.userId)` AND `owner_user_id === ctx.userId`.
 *   First-write wins on the name + icon — if the row already exists, the PUT
 *   is a no-op so a second device's idempotent bootstrap doesn't clobber data
 *   the user changed elsewhere. `slug` always stays null on personal (personal
 *   workspaces don't carry URL slugs).
 * - **Personal workspace PATCH**: name and icon mutable; slug is rejected
 *   (`PERSONAL_WORKSPACE_SLUG_FORBIDDEN`). Gated on admin of the workspace.
 * - **Shared workspace PUT**: gated by `allowWorkspaceCreationByMembers`.
 *   Members may create only when the flag is on; users who already admin some
 *   workspace can always create regardless of the flag.
 * - **Shared workspace PATCH**: requires the caller to be admin of the target.
 *   name, slug, and icon are mutable.
 * - **Duplicate slug**: Postgres `UNIQUE INDEX idx_workspaces_slug` rejects
 *   the write; the apply layer catches it and surfaces `WORKSPACE_SLUG_TAKEN`
 *   as a permanent rejection.
 * - **DELETE**: out of scope for v1.
 */
export const workspacesHandler: UploadHandler = {
  validate: async (op, ctx, tx) => {
    if (op.op === 'DELETE') {
      return reject('permanent', 'WORKSPACE_DELETE_DISABLED')
    }

    const existing = await getWorkspaceById(tx, op.id)

    if (op.op === 'PATCH') {
      if (!existing) {
        return reject('permanent', 'ROW_NOT_FOUND')
      }
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      if (existing.isPersonal && op.data?.slug !== undefined) {
        return reject('permanent', 'PERSONAL_WORKSPACE_SLUG_FORBIDDEN')
      }
      return allow()
    }

    // PUT — split by personal vs shared via the payload + id checks.
    const payloadIsPersonal = op.data?.is_personal === true
    const canonicalPersonalId = computePersonalWorkspaceId(ctx.userId)
    const idMatchesCanonical = op.id === canonicalPersonalId

    if (payloadIsPersonal || idMatchesCanonical || existing?.isPersonal) {
      // This is a personal-workspace PUT. Accept only if both the canonical id
      // and the ownership claim match the caller. Anything else — wrong id,
      // someone else's owner_user_id — is rejected.
      if (!idMatchesCanonical) {
        return reject('permanent', 'PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
      }
      const claimedOwner = typeof op.data?.owner_user_id === 'string' ? op.data.owner_user_id : undefined
      if (claimedOwner !== undefined && claimedOwner !== ctx.userId) {
        return reject('permanent', 'PERSONAL_WORKSPACE_OWNER_MISMATCH')
      }
      if (existing && !existing.isPersonal) {
        // The canonical id is already used by a non-personal workspace —
        // structurally impossible if the canonical hashing is correct, but
        // refuse anyway rather than silently mutate a shared workspace.
        return reject('permanent', 'PERSONAL_WORKSPACE_ID_COLLISION')
      }
      return allow()
    }

    // Shared workspace PUT.
    if (existing) {
      // Updating an existing shared workspace via PUT.
      if (!(await isWorkspaceAdmin(tx, op.id, ctx.userId))) {
        return reject('permanent', 'NOT_WORKSPACE_ADMIN')
      }
      return allow()
    }

    const memberMayCreate =
      ctx.settings.allowWorkspaceCreationByMembers || (await isAdminOfAnyWorkspace(tx, ctx.userId))
    if (!memberMayCreate) {
      return reject('permanent', 'WORKSPACE_CREATION_DISABLED')
    }

    return allow()
  },

  apply: async (op, ctx, tx) => {
    switch (op.op) {
      case 'PUT': {
        const canonicalPersonalId = computePersonalWorkspaceId(ctx.userId)
        const isPersonalPut = op.data?.is_personal === true || op.id === canonicalPersonalId
        const incomingName = typeof op.data?.name === 'string' ? op.data.name : null
        // Personal workspaces default to "Default" if the client omitted the name
        // (defensive — current clients always send one). Shared workspaces require it.
        const name = incomingName ?? (isPersonalPut ? 'Default' : null)
        if (!name) {
          throw new UploadRejection('permanent', 'WORKSPACE_NAME_REQUIRED')
        }
        // Distinguish "key omitted from payload" (undefined) from "explicitly
        // null" so an admin's idempotent PUT that doesn't carry slug/icon
        // doesn't clobber values already on the server. `upsertWorkspace`'s
        // ON CONFLICT only writes columns whose input value is `!== undefined`.
        const slug = op.data?.slug === undefined ? undefined : typeof op.data.slug === 'string' ? op.data.slug : null
        const icon = op.data?.icon === undefined ? undefined : typeof op.data.icon === 'string' ? op.data.icon : null
        if (isPersonalPut) {
          // `DO NOTHING` on conflict — preserves any later changes if a second
          // device's bootstrap PUT lands after the user already mutated the row.
          await insertPersonalWorkspaceIfMissing(tx, {
            id: op.id,
            name,
            icon: icon ?? null,
            ownerUserId: ctx.userId,
          })
          return
        }
        await runWithSlugViolationGuard(() =>
          upsertWorkspace(tx, {
            id: op.id,
            name,
            slug,
            icon,
            isPersonal: false,
            ownerUserId: null,
          }),
        )
        return
      }
      case 'PATCH': {
        const patch: { name?: string; slug?: string | null; icon?: string | null } = {}
        if (typeof op.data?.name === 'string') {
          patch.name = op.data.name
        }
        if (op.data?.slug !== undefined) {
          patch.slug = typeof op.data.slug === 'string' ? op.data.slug : null
        }
        if (op.data?.icon !== undefined) {
          patch.icon = typeof op.data.icon === 'string' ? op.data.icon : null
        }
        if (Object.keys(patch).length === 0) {
          throw new UploadRejection('permanent', 'EMPTY_PAYLOAD')
        }
        const affected = await runWithSlugViolationGuard(() => updateWorkspace(tx, op.id, patch))
        if (affected === 0) {
          throw new UploadRejection('permanent', 'ROW_NOT_FOUND')
        }
        return
      }
      case 'DELETE': {
        throw new UploadRejection('permanent', 'WORKSPACE_DELETE_DISABLED')
      }
    }
  },
}

/**
 * Wrap a write that may collide with the partial-unique slug index. Postgres
 * raises `unique_violation` (SQLSTATE 23505) which would otherwise bubble out
 * as a transient retry — we want a permanent `WORKSPACE_SLUG_TAKEN` instead.
 */
const runWithSlugViolationGuard = async <T>(write: () => Promise<T>): Promise<T> => {
  try {
    return await write()
  } catch (err) {
    if (isUniqueViolationOnSlugIndex(err)) {
      throw new UploadRejection('permanent', 'WORKSPACE_SLUG_TAKEN')
    }
    throw err
  }
}

const isUniqueViolationOnSlugIndex = (err: unknown): boolean => {
  // Drizzle wraps the underlying postgres-js error in `.cause`; check both the
  // outer object and its cause.
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const e = candidate as { code?: unknown; constraint_name?: unknown; constraint?: unknown }
    if (e.code !== '23505') {
      continue
    }
    const constraint =
      typeof e.constraint === 'string' ? e.constraint : typeof e.constraint_name === 'string' ? e.constraint_name : null
    if (constraint && constraint.includes('idx_workspaces_slug')) {
      return true
    }
  }
  return false
}
