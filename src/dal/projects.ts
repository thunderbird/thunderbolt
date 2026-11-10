/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Data access for Projects — a workspace of durable instructions shared by every
 * chat assigned to it.
 *
 */

import { and, asc, desc, eq, exists, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatThreadsTable, projectsTable } from '../db/tables'
import { nowIso } from '../lib/utils'
import type { Project } from '../types'
import { getChatActivityQuery, getChatLastActivityId } from './chat-activity-query'

export const maxProjectNameLength = 100
export const maxProjectInstructionsLength = 20_000

/** Thrown when a write would leave a project without a usable name. */
export class ProjectNameRequiredError extends Error {
  constructor() {
    super('Project name is required.')
    this.name = 'ProjectNameRequiredError'
  }
}

export type CreateProjectInput = {
  name: string
  description?: string | null
  instructions?: string | null
  icon?: string | null
  userId?: string | null
}

export type UpdateProjectInput = Partial<
  Pick<CreateProjectInput, 'name' | 'description' | 'instructions' | 'icon'>
> & {}

/**
 * Cap instructions at the prompt budget. Applied on every write path, not just
 * the UI's `maxLength`: instructions go into the stable half of every chat's
 * system prompt, so the DAL is where the bound has to hold.
 */
const capInstructions = (instructions: string | null | undefined): string | null =>
  instructions?.slice(0, maxProjectInstructionsLength) ?? null

/** Reject a blank or over-long name before it reaches the database. */
const assertValidName = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new ProjectNameRequiredError()
  }
  return trimmed.slice(0, maxProjectNameLength)
}

/** Pinned projects first, then latest live chat activity, with project creation as the floor. */
export const getAllProjectsQuery = (db: AnyDrizzleDatabase) => {
  // Correlated per project so the chat lookup uses PowerSync's project index instead of scanning every chat.
  const latestChatActivity = db
    .select({ id: sql<string>`max(${getChatLastActivityId(db)})` })
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.projectId, projectsTable.id), isNull(chatThreadsTable.deletedAt)))
  const lastActivityId = sql<string>`max(${projectsTable.id}, coalesce((${latestChatActivity}), ${projectsTable.id}))`
  return db
    .select(getTableColumns(projectsTable))
    .from(projectsTable)
    .where(isNull(projectsTable.deletedAt))
    .orderBy(
      // NULL pin orders sort first in SQLite unless explicitly placed last.
      sql`CASE WHEN ${projectsTable.pinnedOrder} IS NULL THEN 1 ELSE 0 END`,
      asc(projectsTable.pinnedOrder),
      desc(lastActivityId),
      desc(projectsTable.id),
    )
}

/** All live projects in the same activity order as the reactive sidebar. */
export const getAllProjects = async (db: AnyDrizzleDatabase): Promise<Project[]> =>
  (await getAllProjectsQuery(db)) as Project[]

/** One live project, or null when it does not exist / is soft-deleted. */
export const getProject = async (db: AnyDrizzleDatabase, id: string): Promise<Project | null> => {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), isNull(projectsTable.deletedAt)))
    .limit(1)
  return (rows[0] as Project | undefined) ?? null
}

export const createProject = async (db: AnyDrizzleDatabase, input: CreateProjectInput): Promise<Project> => {
  const row = {
    id: uuidv7(),
    name: assertValidName(input.name),
    description: input.description ?? null,
    instructions: capInstructions(input.instructions),
    icon: input.icon ?? null,
    pinnedOrder: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
    userId: input.userId ?? null,
  }
  await db.insert(projectsTable).values(row)
  return row as Project
}

/** Patch a project and record its edit time without changing its chat activity. */
export const updateProject = async (db: AnyDrizzleDatabase, id: string, patch: UpdateProjectInput): Promise<void> => {
  const values: Record<string, string | number | null> = { updatedAt: nowIso() }
  if (patch.name !== undefined) {
    values.name = assertValidName(patch.name)
  }
  if (patch.description !== undefined) {
    values.description = patch.description
  }
  if (patch.instructions !== undefined) {
    values.instructions = capInstructions(patch.instructions)
  }
  if (patch.icon !== undefined) {
    values.icon = patch.icon
  }
  await db.update(projectsTable).set(values).where(eq(projectsTable.id, id))
}

/**
 * Soft-delete a project and **orphan** its chats — the chats stay, and reappear
 * in the main list with `projectId` cleared. Deleting a workspace should never
 * take a user's conversations with it; removing the chats too is a separate,
 * explicit action.
 */
const softDeleteProjects = async (db: AnyDrizzleDatabase, target: SQL): Promise<void> => {
  const deletedAt = nowIso()
  await db.transaction(async (tx) => {
    await tx
      .update(chatThreadsTable)
      .set({ projectId: null })
      .where(
        and(
          isNull(chatThreadsTable.deletedAt),
          inArray(chatThreadsTable.projectId, tx.select({ id: projectsTable.id }).from(projectsTable).where(target)),
        ),
      )
    await tx.update(projectsTable).set({ deletedAt }).where(target)
  })
}

/** Remove one project while keeping its chats as ordinary chats. */
export const softDeleteProject = (db: AnyDrizzleDatabase, id: string): Promise<void> =>
  softDeleteProjects(db, and(isNull(projectsTable.deletedAt), eq(projectsTable.id, id))!)

/** Remove every live project atomically, keeping all chats and their messages. */
export const softDeleteAllProjects = (db: AnyDrizzleDatabase): Promise<void> =>
  softDeleteProjects(db, isNull(projectsTable.deletedAt))

/** Pin (or unpin, with `null`) a project to the top of the list. */
export const setProjectPinned = async (db: AnyDrizzleDatabase, id: string, order: number | null): Promise<void> => {
  await db.update(projectsTable).set({ pinnedOrder: order, updatedAt: nowIso() }).where(eq(projectsTable.id, id))
}

// ── Chat membership ──────────────────────────────────────────────────────────

/** Live chats in a project, latest activity first. */
export const getProjectChatThreads = async (db: AnyDrizzleDatabase, projectId: string) =>
  getChatActivityQuery(db, eq(chatThreadsTable.projectId, projectId))

/** Move a chat into a live project, or out with `null`. Returns false when the
 * target disappeared, so callers also leave the live session unchanged. */
export const setChatThreadProject = async (
  db: AnyDrizzleDatabase,
  chatThreadId: string,
  projectId: string | null,
): Promise<boolean> => {
  const availableProject = db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId ?? ''), isNull(projectsTable.deletedAt)))
  // Check inside the UPDATE so a synced deletion cannot race a separate read.
  const updated = await db
    .update(chatThreadsTable)
    .set({ projectId })
    .where(and(eq(chatThreadsTable.id, chatThreadId), projectId === null ? undefined : exists(availableProject)))
    .returning({ id: chatThreadsTable.id })
  // Drafts have no row yet, but their session assignment still needs validation.
  return updated.length > 0 || projectId === null || (await availableProject).length > 0
}

// ── Live hooks ───────────────────────────────────────────────────────────────

/** Live projects and readiness, so chats stay visible while their project membership loads. */
export const useProjectsState = () => {
  const db = useDatabase()
  const { data = [], isLoading } = useQuery({
    queryKey: ['projects'],
    query: toCompilableQuery(getAllProjectsQuery(db)),
  })
  return { projects: data as Project[], isLoading }
}

/** Live list of projects (pinned first, then latest chat activity). */
export const useProjects = (): Project[] => useProjectsState().projects
