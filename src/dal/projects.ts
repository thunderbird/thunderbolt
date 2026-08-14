/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Data access for Projects — a workspace of durable instructions shared by every
 * chat assigned to it.
 *
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatMessagesTable, chatThreadsTable, projectsTable } from '../db/tables'
import { nowIso, uuidv7ToDate } from '../lib/utils'
import { renderHtmlToolName } from '@/artifacts/constants'
import { isRenderHtmlPart, renderHtmlInput } from '@/artifacts/render-html-tool'
import type { UIMessage } from 'ai'
import type { Project } from '../types'

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

/**
 * Ordering for the project list: pinned first (by pin order), then most
 * recently updated. The leading expression is required, not decorative —
 * SQLite sorts NULLs *first* on `ASC`, so ordering by `pinned_order` alone puts
 * every unpinned project above the pinned ones. Shared by the query and the
 * live hook so the two can't drift.
 */
const projectListOrder = [
  sql`CASE WHEN ${projectsTable.pinnedOrder} IS NULL THEN 1 ELSE 0 END`,
  asc(projectsTable.pinnedOrder),
  desc(projectsTable.updatedAt),
] as const

/** All live projects, pinned ones first, then most recently updated. */
export const getAllProjects = async (db: AnyDrizzleDatabase): Promise<Project[]> => {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(isNull(projectsTable.deletedAt))
    .orderBy(...projectListOrder)
  return rows as Project[]
}

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

/** Patch a project. `updatedAt` is always bumped so the list re-sorts. */
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
export const softDeleteProject = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  const deletedAt = nowIso()
  await db.update(projectsTable).set({ deletedAt }).where(eq(projectsTable.id, id))
  await db
    .update(chatThreadsTable)
    .set({ projectId: null })
    .where(and(eq(chatThreadsTable.projectId, id), isNull(chatThreadsTable.deletedAt)))
}

/** Pin (or unpin, with `null`) a project to the top of the list. */
export const setProjectPinned = async (db: AnyDrizzleDatabase, id: string, order: number | null): Promise<void> => {
  await db.update(projectsTable).set({ pinnedOrder: order, updatedAt: nowIso() }).where(eq(projectsTable.id, id))
}

// ── Chat membership ──────────────────────────────────────────────────────────

/** Live chats in a project, newest first. */
export const getProjectChatThreads = async (db: AnyDrizzleDatabase, projectId: string) =>
  db
    .select()
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.projectId, projectId), isNull(chatThreadsTable.deletedAt)))
    .orderBy(desc(chatThreadsTable.id))

/** Move a chat into a project, or out of every project with `null`. */
export const setChatThreadProject = async (
  db: AnyDrizzleDatabase,
  chatThreadId: string,
  projectId: string | null,
): Promise<void> => {
  await db.update(chatThreadsTable).set({ projectId }).where(eq(chatThreadsTable.id, chatThreadId))
}

// ── Live hooks ───────────────────────────────────────────────────────────────

/** Live list of projects (pinned first, then most recently updated). */
export const useProjects = (): Project[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['projects'],
    query: toCompilableQuery(
      db
        .select()
        .from(projectsTable)
        .where(isNull(projectsTable.deletedAt))
        .orderBy(...projectListOrder),
    ),
  })
  return data as Project[]
}

/**
 * Live chat counts per project, keyed by project id.
 *
 * A reactive query rather than a plain one: the previous version keyed a
 * `useQuery` on `projects.length`, so a chat added to (or removed from) a project
 * never changed the key and the count went stale until an unrelated project was
 * created. PowerSync re-runs this whenever `chat_threads` changes.
 */
export const useProjectChatCounts = (): Record<string, number> => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['projectChatCounts'],
    query: toCompilableQuery(
      db
        .select({ projectId: chatThreadsTable.projectId, count: sql<number>`count(*)`.as('count') })
        .from(chatThreadsTable)
        .where(isNull(chatThreadsTable.deletedAt))
        .groupBy(chatThreadsTable.projectId),
    ),
  })
  const counts: Record<string, number> = {}
  for (const row of data as { projectId: string | null; count: number }[]) {
    if (row.projectId) {
      counts[row.projectId] = Number(row.count)
    }
  }
  return counts
}

/**
 * Live chats in a project with their last-activity time.
 *
 * `MAX(id)` over UUIDv7 message ids is both the newest message and when it
 * happened — `chat_messages` has no timestamp column. Sorting happens in JS
 * because the value is derived after the query.
 */
export const useProjectChats = (
  projectId: string | undefined,
): { id: string; title: string | null; lastActivityAt: Date }[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['projectChats', projectId ?? 'none'],
    query: toCompilableQuery(
      db
        .select({
          id: chatThreadsTable.id,
          title: chatThreadsTable.title,
          lastMessageId: sql<string | null>`max(${chatMessagesTable.id})`.as('last_message_id'),
        })
        .from(chatThreadsTable)
        .leftJoin(
          chatMessagesTable,
          and(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id), isNull(chatMessagesTable.deletedAt)),
        )
        .where(and(eq(chatThreadsTable.projectId, projectId ?? ''), isNull(chatThreadsTable.deletedAt)))
        .groupBy(chatThreadsTable.id, chatThreadsTable.title),
    ),
  })
  return (data as { id: string; title: string | null; lastMessageId: string | null }[])
    .map((row) => ({
      id: row.id,
      title: row.title,
      lastActivityAt: uuidv7ToDate(row.lastMessageId ?? row.id),
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
}

/** Live `render_html` artifacts across a project's chats, newest first. */
export const useProjectArtifacts = (projectId: string | undefined): ProjectArtifact[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['projectArtifacts', projectId ?? 'none'],
    query: toCompilableQuery(
      db
        .select({
          id: chatMessagesTable.id,
          chatThreadId: chatMessagesTable.chatThreadId,
          parts: chatMessagesTable.parts,
          chatTitle: chatThreadsTable.title,
        })
        .from(chatMessagesTable)
        .innerJoin(chatThreadsTable, eq(chatThreadsTable.id, chatMessagesTable.chatThreadId))
        .where(
          and(
            eq(chatThreadsTable.projectId, projectId ?? ''),
            isNull(chatThreadsTable.deletedAt),
            isNull(chatMessagesTable.deletedAt),
            // Narrows the scan before any JSON is parsed.
            sql`${chatMessagesTable.parts} LIKE ${`%${renderHtmlToolName}%`}`,
          ),
        ),
    ),
  })
  return toArtifacts(data as { id: string; chatThreadId: string | null; parts: unknown; chatTitle: string | null }[])
}

/** An HTML artifact produced somewhere in a project's chats. */
export type ProjectArtifact = {
  /**
   * Message id plus the artifact's index within that message. One assistant
   * message can emit several `render_html` parts, and two of them can share a
   * title (both fall back to 'Untitled artifact'), so neither the message id nor
   * the title is unique on its own.
   */
  id: string
  messageId: string
  chatThreadId: string
  chatTitle: string
  title: string
  createdAt: Date
}

/**
 * Every `render_html` artifact across a project's chats, newest first.
 *
 * Artifacts aren't a table — they're `render_html` tool parts inside message
 * JSON. The `LIKE` narrows the scan to rows that mention the tool at all before
 * anything is parsed, so a project with thousands of ordinary messages doesn't
 * pay to JSON-parse all of them.
 */
const toArtifacts = (
  rows: readonly { id: string; chatThreadId: string | null; parts: unknown; chatTitle: string | null }[],
): ProjectArtifact[] =>
  rows
    .flatMap((row) =>
      parseParts(row.parts)
        .filter(isRenderHtmlPart)
        .map((part, index) => ({
          id: `${row.id}-${index}`,
          messageId: row.id,
          chatThreadId: row.chatThreadId ?? '',
          chatTitle: row.chatTitle ?? 'Untitled chat',
          title: renderHtmlInput(part).title?.trim() || 'Untitled artifact',
          createdAt: uuidv7ToDate(row.id),
        })),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

/** `parts` is a JSON column; the driver may hand back a string or a parsed value. */
const parseParts = (parts: unknown): UIMessage['parts'] => {
  if (Array.isArray(parts)) {
    return parts as UIMessage['parts']
  }
  if (typeof parts !== 'string') {
    return []
  }
  try {
    const parsed = JSON.parse(parts)
    return Array.isArray(parsed) ? (parsed as UIMessage['parts']) : []
  } catch {
    return []
  }
}
