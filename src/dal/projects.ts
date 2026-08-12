/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Data access for Projects — a workspace of durable instructions plus a text
 * knowledge set, shared by every chat assigned to it.
 *
 * Knowledge is stored as extracted text rather than bytes; see
 * `projectFilesTable` in `src/db/tables.ts` for why.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import {
  chatMessagesTable,
  chatThreadsTable,
  projectFilesTable,
  projectsTable,
  type ProjectFileOrigin,
} from '../db/tables'
import { nowIso, uuidv7ToDate } from '../lib/utils'
import { renderHtmlToolName } from '@/artifacts/constants'
import { isRenderHtmlPart, renderHtmlInput } from '@/artifacts/render-html-tool'
import type { UIMessage } from 'ai'
import type { Project, ProjectFile } from '../types'

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

export type UpdateProjectInput = Partial<Pick<CreateProjectInput, 'name' | 'description' | 'instructions' | 'icon'>> & {
  /** Opt-in for assistant-written notes. */
  agentNotesEnabled?: boolean
}

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
    instructions: input.instructions ?? null,
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
  const next: Record<string, string | null> = { updatedAt: nowIso() }
  if (patch.name !== undefined) {
    next.name = assertValidName(patch.name)
  }
  if (patch.description !== undefined) {
    next.description = patch.description
  }
  if (patch.instructions !== undefined) {
    next.instructions = patch.instructions?.slice(0, maxProjectInstructionsLength) ?? null
  }
  if (patch.icon !== undefined) {
    next.icon = patch.icon
  }
  const values: Record<string, string | number | null> = { ...next }
  if (patch.agentNotesEnabled !== undefined) {
    values.agentNotesEnabled = patch.agentNotesEnabled ? 1 : 0
  }
  await db.update(projectsTable).set(values).where(eq(projectsTable.id, id))
}

/**
 * Soft-delete a project and **orphan** its chats — the chats stay, and reappear
 * in the main list with `projectId` cleared. Deleting a workspace should never
 * take a user's conversations with it; removing the chats too is a separate,
 * explicit action.
 *
 * Knowledge documents belong to the project itself, so those are soft-deleted
 * alongside it.
 */
export const softDeleteProject = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  const deletedAt = nowIso()
  await db.update(projectsTable).set({ deletedAt }).where(eq(projectsTable.id, id))
  await db.update(projectFilesTable).set({ deletedAt }).where(eq(projectFilesTable.projectId, id))
  await db
    .update(chatThreadsTable)
    .set({ projectId: null })
    .where(and(eq(chatThreadsTable.projectId, id), isNull(chatThreadsTable.deletedAt)))
}

/** Pin (or unpin, with `null`) a project to the top of the list. */
export const setProjectPinned = async (db: AnyDrizzleDatabase, id: string, order: number | null): Promise<void> => {
  await db.update(projectsTable).set({ pinnedOrder: order, updatedAt: nowIso() }).where(eq(projectsTable.id, id))
}

// ── Knowledge documents ──────────────────────────────────────────────────────

export type CreateProjectFileInput = {
  projectId: string
  filename: string
  /** Already-extracted text (see `src/projects/extract-knowledge-text.ts`). */
  content: string
  sourceMimeType?: string | null
  /** Defaults to `upload`; notes and assistant-written entries say so. */
  origin?: ProjectFileOrigin
  userId?: string | null
}

/** Per-project ceiling on assistant-written notes. Without a cap the assistant
 *  could quietly fill the knowledge budget and evict the user's own documents. */
export const maxAgentNotes = 25

/**
 * Knowledge documents for a project.
 *
 * User-authored content (uploads and typed notes) sorts ahead of assistant-written
 * notes, oldest first within each group. That ordering is what protects the prompt
 * budget: `selectWithinBudget` fills in order, so anything the assistant wrote is
 * dropped before a document the user chose to add.
 */
export const getProjectFiles = async (db: AnyDrizzleDatabase, projectId: string): Promise<ProjectFile[]> => {
  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), isNull(projectFilesTable.deletedAt)))
    .orderBy(sql`CASE WHEN ${projectFilesTable.origin} = 'agent' THEN 1 ELSE 0 END`, asc(projectFilesTable.createdAt))
  return rows as ProjectFile[]
}

/** Count of assistant-written notes in a project (enforces {@link maxAgentNotes}). */
export const countAgentNotes = async (db: AnyDrizzleDatabase, projectId: string): Promise<number> => {
  const rows = (await db
    .select({ count: sql<number>`count(*)` })
    .from(projectFilesTable)
    .where(
      and(
        eq(projectFilesTable.projectId, projectId),
        eq(projectFilesTable.origin, 'agent'),
        isNull(projectFilesTable.deletedAt),
      ),
    )) as { count: number }[]
  return Number(rows[0]?.count ?? 0)
}

export const addProjectFile = async (db: AnyDrizzleDatabase, input: CreateProjectFileInput): Promise<ProjectFile> => {
  const row = {
    id: uuidv7(),
    projectId: input.projectId,
    filename: input.filename,
    origin: input.origin ?? 'upload',
    sourceMimeType: input.sourceMimeType ?? null,
    content: input.content,
    size: input.content.length,
    createdAt: nowIso(),
    deletedAt: null,
    userId: input.userId ?? null,
  }
  await db.insert(projectFilesTable).values(row)
  // Knowledge is part of the project's identity, so touching a document makes
  // the project itself newer for list-ordering purposes.
  await db.update(projectsTable).set({ updatedAt: nowIso() }).where(eq(projectsTable.id, input.projectId))
  return row as ProjectFile
}

/** Edit a saved note in place. Size is recomputed so the budget stays honest. */
export const updateProjectFile = async (
  db: AnyDrizzleDatabase,
  id: string,
  patch: { filename?: string; content?: string },
): Promise<void> => {
  const values: Record<string, string | number> = {}
  if (patch.filename !== undefined) {
    values.filename = patch.filename.trim() || 'Note'
  }
  if (patch.content !== undefined) {
    values.content = patch.content
    values.size = patch.content.length
  }
  if (Object.keys(values).length === 0) {
    return
  }
  await db.update(projectFilesTable).set(values).where(eq(projectFilesTable.id, id))
}

export const softDeleteProjectFile = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.update(projectFilesTable).set({ deletedAt: nowIso() }).where(eq(projectFilesTable.id, id))
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
 * Live single project.
 *
 * Reactive rather than a plain `useQuery`: the previous version needed an
 * explicit `refetch()` after every edit, and still showed stale data when the
 * project was changed on another device. (`powersyncTableToQueryKeys` looks like
 * it would cover that, but it has had no consumer since THU-249 — invalidation
 * comes from PowerSync's own reactivity, so a query must be compiled through
 * `toCompilableQuery` to update at all.)
 */
export const useProject = (projectId: string | undefined): Project | null => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['project', projectId ?? 'none'],
    query: toCompilableQuery(
      db
        .select()
        .from(projectsTable)
        // A missing id must still compile, so match nothing.
        .where(and(eq(projectsTable.id, projectId ?? ''), isNull(projectsTable.deletedAt)))
        .limit(1),
    ),
  })
  return (data[0] as Project | undefined) ?? null
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

/** Live knowledge documents for one project. */
export const useProjectFiles = (projectId: string | undefined): ProjectFile[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['projectFiles', projectId ?? 'none'],
    query: toCompilableQuery(
      db
        .select()
        .from(projectFilesTable)
        // A missing id must still produce a valid query, so match nothing.
        .where(and(eq(projectFilesTable.projectId, projectId ?? ''), isNull(projectFilesTable.deletedAt)))
        .orderBy(asc(projectFilesTable.createdAt)),
    ),
  })
  return data as ProjectFile[]
}

/**
 * A project's chats with their last-activity time, derived from the newest
 * message id. `chat_messages` has no timestamp column, but ids are UUIDv7 —
 * lexicographically ordered and carrying a millisecond timestamp — so `MAX(id)`
 * is both the newest message and the time it happened. Falls back to the
 * thread's own id (its creation time) for a chat with no messages yet.
 */
export const getProjectChatSummaries = async (
  db: AnyDrizzleDatabase,
  projectId: string,
): Promise<{ id: string; title: string | null; lastActivityAt: Date }[]> => {
  const rows = (await db.all(sql`
    SELECT t.id AS id, t.title AS title, MAX(m.id) AS last_message_id
    FROM chat_threads t
    LEFT JOIN chat_messages m ON m.chat_thread_id = t.id AND m.deleted_at IS NULL
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
    GROUP BY t.id, t.title
  `)) as { id: string; title: string | null; last_message_id: string | null }[]

  return rows
    .map((row) => ({
      id: row.id,
      title: row.title,
      lastActivityAt: uuidv7ToDate(row.last_message_id ?? row.id),
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
}

/** An HTML artifact produced somewhere in a project's chats. */
export type ProjectArtifact = {
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
        .map((part) => ({
          messageId: row.id,
          chatThreadId: row.chatThreadId ?? '',
          chatTitle: row.chatTitle ?? 'Untitled chat',
          title: renderHtmlInput(part).title?.trim() || 'Untitled artifact',
          createdAt: uuidv7ToDate(row.id),
        })),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

export const getProjectArtifacts = async (db: AnyDrizzleDatabase, projectId: string): Promise<ProjectArtifact[]> => {
  const rows = (await db.all(sql`
    SELECT m.id AS id, m.chat_thread_id AS chat_thread_id, m.parts AS parts, t.title AS chat_title
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.chat_thread_id
    WHERE t.project_id = ${projectId}
      AND t.deleted_at IS NULL
      AND m.deleted_at IS NULL
      AND m.parts LIKE ${`%${renderHtmlToolName}%`}
  `)) as { id: string; chat_thread_id: string; parts: unknown; chat_title: string | null }[]

  return rows
    .flatMap((row) => {
      const parts = parseParts(row.parts)
      return parts.filter(isRenderHtmlPart).map((part) => ({
        messageId: row.id,
        chatThreadId: row.chat_thread_id,
        chatTitle: row.chat_title ?? 'Untitled chat',
        title: renderHtmlInput(part).title?.trim() || 'Untitled artifact',
        createdAt: uuidv7ToDate(row.id),
      }))
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

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
