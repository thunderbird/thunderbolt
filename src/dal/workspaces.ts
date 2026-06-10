/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, desc, eq } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import { seedFreshWorkspaceDefaultsInTx } from '@/lib/reconcile-defaults'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'
import { computePersonalAdminMembershipId, computePersonalWorkspaceId } from '@shared/workspaces'

export type Workspace = {
  id: string
  name: string
  isPersonal: number
  ownerUserId: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Drizzle query for the personal workspace owned by `userId`. Use with
 * PowerSync's `toCompilableQuery` (live React subscription) or `await` for a
 * one-shot read. Single source of truth for the personal-workspace WHERE
 * clause — `getPersonalWorkspaceByOwner` and `useActiveWorkspaceId` both go
 * through this so they can't drift.
 */
export const getPersonalWorkspaceByOwnerQuery = (db: AnyDrizzleDatabase, userId: string) => {
  const query = db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.ownerUserId, userId), eq(workspacesTable.isPersonal, 1)))
    .limit(1)
  return query as typeof query & DrizzleQueryWithPromise<Workspace>
}

/**
 * Look up the personal workspace for a given user. Returns `null` if the row
 * hasn't synced down yet (first signup) or if the user has none — the boot path
 * awaits this becoming non-null before proceeding to reconcile defaults.
 */
export const getPersonalWorkspaceByOwner = async (
  db: AnyDrizzleDatabase,
  userId: string,
): Promise<Workspace | null> => {
  const row = await getPersonalWorkspaceByOwnerQuery(db, userId).get()
  return (row ?? null) as Workspace | null
}

/**
 * Drizzle query for a workspace by id. Use with PowerSync's `toCompilableQuery`
 * for a live subscription (the active-workspace hook does this when the URL
 * carries a `/w/<id>/` prefix).
 */
export const getWorkspaceByIdQuery = (db: AnyDrizzleDatabase, id: string) => {
  const query = db.select().from(workspacesTable).where(eq(workspacesTable.id, id)).limit(1)
  return query as typeof query & DrizzleQueryWithPromise<Workspace>
}

/** Fetch a workspace by id. Used by the URL-driven workspace selector. */
export const getWorkspaceById = async (db: AnyDrizzleDatabase, id: string): Promise<Workspace | null> => {
  const row = await getWorkspaceByIdQuery(db, id).get()
  return (row ?? null) as Workspace | null
}

/**
 * Drizzle query for every workspace the user is a member of. Joins
 * `workspaces × workspace_memberships` on `workspace_id`, scoped to
 * `memberships.userId = userId`. Sorted personal-first, then alpha by name so
 * the sidebar selector renders the user's home workspace at the top.
 */
export const getWorkspacesForUserQuery = (db: AnyDrizzleDatabase, userId: string) => {
  const query = db
    .select({
      id: workspacesTable.id,
      name: workspacesTable.name,
      isPersonal: workspacesTable.isPersonal,
      ownerUserId: workspacesTable.ownerUserId,
      createdAt: workspacesTable.createdAt,
      updatedAt: workspacesTable.updatedAt,
    })
    .from(workspacesTable)
    .innerJoin(workspaceMembershipsTable, eq(workspaceMembershipsTable.workspaceId, workspacesTable.id))
    .where(eq(workspaceMembershipsTable.userId, userId))
    .orderBy(desc(workspacesTable.isPersonal), asc(workspacesTable.name))
  return query as typeof query & DrizzleQueryWithPromise<Workspace>
}

/**
 * Live hook returning every workspace the active user is a member of. Reads
 * the active user id from the trust-domain registry (same source as
 * `useActiveWorkspace`), so it works wherever the registry is mirrored from
 * Better Auth — outside of `<AuthProvider>` it just stays empty until the
 * registry hydrates. Returns `[]` until the live query resolves; consumers
 * that need a loading state can inspect the underlying React Query (this hook
 * intentionally keeps the signature minimal — sidebar / selector code reads
 * the array, not a loading flag).
 */
export const useWorkspacesQuery = (): Workspace[] => {
  const db = useDatabase()
  const userId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })
  const { data = [] } = useQuery({
    queryKey: ['workspaces', 'for-user', userId],
    query: toCompilableQuery(getWorkspacesForUserQuery(db, userId ?? '')),
    enabled: !!userId,
  })
  return data
}

/**
 * Resolve or create the user's personal workspace locally.
 *
 * The personal workspace + admin membership are FE-created with deterministic
 * ids (`shared/workspaces.ts`). Multi-device safe by construction — every
 * device computes the same id and uploads the same row, so PowerSync uploads
 * become upserts on the BE rather than racing for a unique constraint.
 *
 * Called from `runPostAuthBootstrap` once a session is established. No sync
 * dependency: the workspace is usable immediately, sync uploads it (and any
 * later edits) when the user enables sync.
 */
export const ensurePersonalWorkspace = async (db: AnyDrizzleDatabase, userId: string): Promise<Workspace> => {
  const existing = await getPersonalWorkspaceByOwner(db, userId)
  if (existing) {
    return existing
  }

  const workspaceId = computePersonalWorkspaceId(userId)
  const membershipId = computePersonalAdminMembershipId(userId)
  const nowIso = new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.insert(workspacesTable).values({
      id: workspaceId,
      name: 'Default',
      isPersonal: 1,
      ownerUserId: userId,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    await tx.insert(workspaceMembershipsTable).values({
      id: membershipId,
      workspaceId,
      userId,
      role: 'admin',
      createdAt: nowIso,
    })
  })

  const created = await getPersonalWorkspaceByOwner(db, userId)
  if (!created) {
    throw new Error(`Failed to create personal workspace for user ${userId}`)
  }
  return created
}

export type CreateSharedWorkspaceInput = {
  creatorUserId: string
  /** Display name. Trimmed before storage. */
  name: string
  /** Raw emails from the invite step. Lowercased + trimmed + deduped here; the
   *  creator's own email is filtered out so the modal can pass session input
   *  verbatim without special-casing. */
  invitedEmails?: string[]
  /** The creator's email, used to filter their own address out of the invite
   *  list. Optional — pass when known (real users); anon sessions have none. */
  creatorEmail?: string
  /** Role assigned to invitees. Defaults to 'member'. */
  inviteRole?: 'admin' | 'member'
}

const normalizeInviteEmail = (email: string): string => email.toLowerCase().trim()

/**
 * Create a new shared workspace owned by the active user, with the creator as
 * admin and one `workspace_pending_memberships` row per invited email.
 *
 * All inserts happen in a single local SQLite transaction; PowerSync uploads
 * the four (or N+2) rows as one batch. The BE's `workspace_pending_memberships`
 * upload handler resolves each invited email server-side — if it belongs to a
 * real user, the BE promotes the pending row to an active membership in the
 * same upload tx (see backend `workspace-pending-memberships.ts`).
 *
 * Returns the new workspace id. Caller is expected to navigate after this
 * resolves.
 */
export const createSharedWorkspace = async (
  db: AnyDrizzleDatabase,
  input: CreateSharedWorkspaceInput,
): Promise<string> => {
  const trimmedName = input.name.trim()
  if (!trimmedName) {
    throw new Error('Workspace name is required')
  }

  const workspaceId = uuidv7()
  const membershipId = uuidv7()
  const role = input.inviteRole ?? 'member'
  const nowIso = new Date().toISOString()

  const normalizedCreatorEmail = input.creatorEmail ? normalizeInviteEmail(input.creatorEmail) : null
  const emails = Array.from(
    new Set(
      (input.invitedEmails ?? [])
        .map(normalizeInviteEmail)
        .filter((email) => email.length > 0 && email !== normalizedCreatorEmail),
    ),
  )

  await db.transaction(async (tx) => {
    await tx.insert(workspacesTable).values({
      id: workspaceId,
      name: trimmedName,
      isPersonal: 0,
      ownerUserId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    await tx.insert(workspaceMembershipsTable).values({
      id: membershipId,
      workspaceId,
      userId: input.creatorUserId,
      role: 'admin',
      createdAt: nowIso,
    })
    for (const email of emails) {
      await tx.insert(workspacePendingMembershipsTable).values({
        id: uuidv7(),
        workspaceId,
        email,
        role,
        invitedByUserId: input.creatorUserId,
        createdAt: nowIso,
      })
    }
    // Seed default models / modes / skills / tasks / profiles into the new
    // workspace inside the same transaction so the workspace is usable the
    // moment it commits — without this, the creator would land on
    // /w/<newId>/ with empty pickers everywhere. Uses fresh per-workspace ids
    // to avoid colliding with the personal workspace's default rows (the FE
    // PK is single-column `id`).
    await seedFreshWorkspaceDefaultsInTx(tx, workspaceId)
  })

  return workspaceId
}

export type AddPendingMembershipsInput = {
  workspaceId: string
  invitedByUserId: string
  /** Optional — the inviter's email is normalized and filtered out so the modal
   *  can pass raw textarea input without special-casing self-invites. */
  creatorEmail?: string
  emails: string[]
  role?: 'admin' | 'member'
}

/**
 * Inserts one `workspace_pending_memberships` row per (lowercased + trimmed)
 * email into an existing workspace. Returns the number of pending rows
 * written. Used by the post-create invite modal — the workspace itself is
 * created by `createSharedWorkspace`.
 *
 * The BE upload handler promotes pending rows to active memberships when the
 * invited email matches an existing user (see
 * `backend/src/powersync/upload-handlers/workspace-pending-memberships.ts`).
 */
export const addPendingMemberships = async (
  db: AnyDrizzleDatabase,
  input: AddPendingMembershipsInput,
): Promise<number> => {
  const role = input.role ?? 'member'
  const normalizedCreatorEmail = input.creatorEmail ? normalizeInviteEmail(input.creatorEmail) : null
  const emails = Array.from(
    new Set(
      input.emails.map(normalizeInviteEmail).filter((email) => email.length > 0 && email !== normalizedCreatorEmail),
    ),
  )
  if (emails.length === 0) {
    return 0
  }

  await db.transaction(async (tx) => {
    for (const email of emails) {
      await tx.insert(workspacePendingMembershipsTable).values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        email,
        role,
        invitedByUserId: input.invitedByUserId,
      })
    }
  })

  return emails.length
}

/**
 * Rename a workspace. PowerSync emits a PATCH op; the BE upload handler accepts
 * iff the caller is admin of a shared workspace, and permanent-rejects PATCH on
 * personal workspaces (Decision 11 — non-editable). The FE UI gates access
 * before reaching this function; the throw here is a defensive backstop.
 */
export const updateWorkspaceName = async (db: AnyDrizzleDatabase, workspaceId: string, name: string): Promise<void> => {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Workspace name is required')
  }
  await db
    .update(workspacesTable)
    .set({ name: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(workspacesTable.id, workspaceId))
}
