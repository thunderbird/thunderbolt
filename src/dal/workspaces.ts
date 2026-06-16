/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import { seedFreshWorkspaceDefaultsInTx } from '@/lib/reconcile-defaults'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import {
  agentsTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  skillsTable,
  tasksTable,
  triggersTable,
  workspaceMembershipsTable,
  workspacePendingMembershipsTable,
  workspacesTable,
} from '../db/tables'
import type { DrizzleQueryWithPromise } from '../types'
import { computePersonalAdminMembershipId, computePersonalWorkspaceId } from '@shared/workspaces'

export type Workspace = {
  id: string
  name: string
  slug: string | null
  icon: string | null
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
      slug: workspacesTable.slug,
      icon: workspacesTable.icon,
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
  /** Optional URL slug. Already-sanitised text expected; persisted as-is. */
  slug?: string | null
  /** Optional icon (emoji string or `data:image/...` URL). */
  icon?: string | null
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

  const trimmedSlug = input.slug?.trim() || null
  const icon = input.icon ?? null

  await db.transaction(async (tx) => {
    await tx.insert(workspacesTable).values({
      id: workspaceId,
      name: trimmedName,
      slug: trimmedSlug,
      icon,
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

export type UpdateWorkspacePatch = {
  /** Trimmed before writing; throws on empty/whitespace. Omit to leave unchanged. */
  name?: string
  /** Slug to persist (already sanitized). Pass `null` to clear, omit to leave unchanged. */
  slug?: string | null
  /** Icon (emoji or base64 image). Pass `null` to clear, omit to leave unchanged. */
  icon?: string | null
}

/**
 * Patch a workspace's mutable fields (`name`, `slug`, `icon`). PowerSync emits
 * a PATCH op the BE handler validates as admin-of-the-workspace; Personal-slug
 * writes are rejected server-side. The FE UI gates access before reaching this
 * function; the empty-name throw is a defensive backstop.
 */
export const updateWorkspace = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  patch: UpdateWorkspacePatch,
): Promise<void> => {
  const setClause: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    if (!trimmed) {
      throw new Error('Workspace name is required')
    }
    setClause.name = trimmed
  }
  if (patch.slug !== undefined) {
    setClause.slug = patch.slug
  }
  if (patch.icon !== undefined) {
    setClause.icon = patch.icon
  }
  if (Object.keys(setClause).length === 1) {
    // Only `updatedAt` would change — caller passed no actual edits. Skip the write.
    return
  }
  await db.update(workspacesTable).set(setClause).where(eq(workspacesTable.id, workspaceId))
}

export type DuplicateWorkspaceInput = {
  creatorUserId: string
  /** Name for the new workspace (e.g. `${source.name} Copy`). Trimmed before storage. */
  name: string
  /** Optional slug for the new workspace. Persisted as-is; the BE handler rejects on collision. */
  slug?: string | null
  /** Optional icon (emoji or `data:` URL) inherited from the source by default. */
  icon?: string | null
}

/**
 * Duplicate a workspace into a brand-new shared workspace. Clones every
 * workspace-scoped table EXCEPT `chat_threads` / `chat_messages` (per
 * THU-554's UX call — chat history is conversation context, not workspace
 * configuration, so it should not carry over).
 *
 * Foreign-key remap: source ids are replaced with freshly-generated `uuidv7`
 * ids, and cross-table references are remapped via in-memory maps:
 *   - `prompts.model_id` → remapped to the cloned model's new id.
 *   - `triggers.prompt_id` → remapped to the cloned prompt's new id.
 *   - `model_profiles.id` (which is the model id) → remapped to the cloned model.
 *
 * Soft-deleted rows (`deletedAt IS NOT NULL`) are skipped — duplicating
 * tombstones serves no purpose. `defaultHash`, `userId`, and other attribution
 * columns are preserved so reconcile-defaults treats the clones identically
 * to the originals.
 *
 * **Perf:** all reads run as a single `Promise.all`, all writes as a single
 * batched insert per table inside another `Promise.all`. SQLite still
 * serialises statements under a single connection, but JS-side overhead and
 * round-trip waiting drop to one per phase.
 *
 * Returns the new workspace id.
 */
export const duplicateWorkspace = async (
  db: AnyDrizzleDatabase,
  source: Workspace,
  input: DuplicateWorkspaceInput,
): Promise<string> => {
  const trimmedName = input.name.trim()
  if (!trimmedName) {
    throw new Error('Workspace name is required')
  }

  const newWorkspaceId = uuidv7()
  const membershipId = uuidv7()
  const nowIso = new Date().toISOString()
  const trimmedSlug = input.slug?.trim() || null
  const icon = input.icon ?? null

  await db.transaction(async (tx) => {
    // Read every workspace-scoped table in parallel, then build the new rows
    // in pure JS, then write them in parallel. Three phases, two awaits.
    const [models, profiles, prompts, triggers, skills, modes, mcpServers, agents, tasks] = await Promise.all([
      tx
        .select()
        .from(modelsTable)
        .where(and(eq(modelsTable.workspaceId, source.id), isNull(modelsTable.deletedAt))),
      tx
        .select()
        .from(modelProfilesTable)
        .where(and(eq(modelProfilesTable.workspaceId, source.id), isNull(modelProfilesTable.deletedAt))),
      tx
        .select()
        .from(promptsTable)
        .where(and(eq(promptsTable.workspaceId, source.id), isNull(promptsTable.deletedAt))),
      tx
        .select()
        .from(triggersTable)
        .where(and(eq(triggersTable.workspaceId, source.id), isNull(triggersTable.deletedAt))),
      tx
        .select()
        .from(skillsTable)
        .where(and(eq(skillsTable.workspaceId, source.id), isNull(skillsTable.deletedAt))),
      tx
        .select()
        .from(modesTable)
        .where(and(eq(modesTable.workspaceId, source.id), isNull(modesTable.deletedAt))),
      tx
        .select()
        .from(mcpServersTable)
        .where(and(eq(mcpServersTable.workspaceId, source.id), isNull(mcpServersTable.deletedAt))),
      tx
        .select()
        .from(agentsTable)
        .where(and(eq(agentsTable.workspaceId, source.id), isNull(agentsTable.deletedAt))),
      tx
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.workspaceId, source.id), isNull(tasksTable.deletedAt))),
    ])

    // Build id maps + new row arrays in pure JS — no awaits in this section.
    const modelIdMap = new Map<string, string>()
    const newModels = models.map((row) => {
      const newId = uuidv7()
      modelIdMap.set(row.id, newId)
      return { ...row, id: newId, workspaceId: newWorkspaceId }
    })

    const promptIdMap = new Map<string, string>()
    const newPrompts = prompts.map((row) => {
      const newId = uuidv7()
      promptIdMap.set(row.id, newId)
      return {
        ...row,
        id: newId,
        modelId: row.modelId ? (modelIdMap.get(row.modelId) ?? null) : null,
        workspaceId: newWorkspaceId,
      }
    })

    const newProfiles = profiles.flatMap((row) => {
      const newModelId = modelIdMap.get(row.modelId)
      if (!newModelId) {
        return []
      }
      return [{ ...row, modelId: newModelId, workspaceId: newWorkspaceId }]
    })

    const newTriggers = triggers.map((row) => ({
      ...row,
      id: uuidv7(),
      promptId: row.promptId ? (promptIdMap.get(row.promptId) ?? null) : null,
      workspaceId: newWorkspaceId,
    }))

    const cloneFreshId = <T extends { id: string }>(row: T): T => ({
      ...row,
      id: uuidv7(),
      workspaceId: newWorkspaceId,
    })
    const newSkills = skills.map(cloneFreshId)
    const newModes = modes.map(cloneFreshId)
    const newMcpServers = mcpServers.map(cloneFreshId)
    const newAgents = agents.map(cloneFreshId)
    const newTasks = tasks.map(cloneFreshId)

    // All writes in parallel. Workspace + membership go alongside the table
    // clones — none of the FE rows have FK constraints to enforce ordering.
    const writes: Promise<unknown>[] = [
      tx.insert(workspacesTable).values({
        id: newWorkspaceId,
        name: trimmedName,
        slug: trimmedSlug,
        icon,
        isPersonal: 0,
        ownerUserId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      tx.insert(workspaceMembershipsTable).values({
        id: membershipId,
        workspaceId: newWorkspaceId,
        userId: input.creatorUserId,
        role: 'admin',
        createdAt: nowIso,
      }),
    ]
    if (newModels.length) {
      writes.push(tx.insert(modelsTable).values(newModels))
    }
    if (newProfiles.length) {
      writes.push(tx.insert(modelProfilesTable).values(newProfiles))
    }
    if (newPrompts.length) {
      writes.push(tx.insert(promptsTable).values(newPrompts))
    }
    if (newTriggers.length) {
      writes.push(tx.insert(triggersTable).values(newTriggers))
    }
    if (newSkills.length) {
      writes.push(tx.insert(skillsTable).values(newSkills))
    }
    if (newModes.length) {
      writes.push(tx.insert(modesTable).values(newModes))
    }
    if (newMcpServers.length) {
      writes.push(tx.insert(mcpServersTable).values(newMcpServers))
    }
    if (newAgents.length) {
      writes.push(tx.insert(agentsTable).values(newAgents))
    }
    if (newTasks.length) {
      writes.push(tx.insert(tasksTable).values(newTasks))
    }
    await Promise.all(writes)
  })

  return newWorkspaceId
}
