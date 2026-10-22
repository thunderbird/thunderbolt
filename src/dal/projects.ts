/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Data access for Projects — a workspace of durable instructions shared by every
 * chat assigned to it.
 *
 */

import { and, asc, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useLingui } from '@lingui/react/macro'
import { useMemo } from 'react'
import { chatTitleLabel } from '@/lib/title-generator'
import { v7 as uuidv7 } from 'uuid'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatMessagesTable, chatThreadsTable, projectsTable } from '../db/tables'
import { nowIso } from '../lib/utils'
import { renderHtmlToolName } from '@/artifacts/constants'
import { collectProjectArtifacts, type ArtifactMessageRow } from '@/projects/project-artifacts-data'
import { applyArtifactPresentation, artifactPresentationKeys } from '@/projects/artifact-presentation'
import { getArtifactPresentationRecords } from './project-artifact-presentation'
import type { Project } from '../types'
import { getChatActivityQuery } from './chat-activity-query'

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
const getAllProjectsQuery = (db: AnyDrizzleDatabase) => {
  const chatActivity = getChatActivityQuery(db).as('project_chat_activity')
  const lastActivityId = sql<string>`max(${projectsTable.id}, coalesce(max(${chatActivity.lastActivityId}), ${projectsTable.id}))`
  return db
    .select(getTableColumns(projectsTable))
    .from(projectsTable)
    .leftJoin(chatActivity, eq(chatActivity.projectId, projectsTable.id))
    .where(isNull(projectsTable.deletedAt))
    .groupBy(projectsTable.id)
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

/** Live chats in a project, latest activity first. */
export const getProjectChatThreads = async (db: AnyDrizzleDatabase, projectId: string) =>
  getChatActivityQuery(db, eq(chatThreadsTable.projectId, projectId))

/** Move a chat into a project, or out of every project with `null`. */
export const setChatThreadProject = async (
  db: AnyDrizzleDatabase,
  chatThreadId: string,
  projectId: string | null,
): Promise<void> => {
  await db.update(chatThreadsTable).set({ projectId }).where(eq(chatThreadsTable.id, chatThreadId))
}

// ── Live hooks ───────────────────────────────────────────────────────────────

/** Live projects and readiness, so deep links distinguish loading from a missing project. */
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

/** Artifact messages from live source chats; moving or deleting a chat removes its outputs from the collection. */
export const getProjectArtifactMessagesQuery = (db: AnyDrizzleDatabase, projectId: string) =>
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
        eq(chatThreadsTable.projectId, projectId),
        isNull(chatThreadsTable.deletedAt),
        isNull(chatMessagesTable.deletedAt),
        eq(chatMessagesTable.role, 'assistant'),
        // Narrows the scan before any JSON is parsed.
        sql`${chatMessagesTable.parts} LIKE ${`%${renderHtmlToolName}%`}`,
      ),
    )

/** Live `render_html` artifacts across a project's chats, newest first. */
export const useProjectArtifactsState = (projectId: string | undefined) => {
  const db = useDatabase()
  const { t, i18n } = useLingui()
  const { data = [], isLoading } = useQuery({
    queryKey: ['projectArtifacts', projectId ?? 'none'],
    query: toCompilableQuery(getProjectArtifactMessagesQuery(db, projectId ?? '')),
  })
  const sourceArtifacts = useMemo(
    () =>
      collectProjectArtifacts(
        (data as ArtifactMessageRow[]).map((row) => ({ ...row, chatTitle: chatTitleLabel(i18n, row.chatTitle) })),
        {
          untitledChat: t`Untitled chat`,
          untitledArtifact: t`Untitled artifact`,
        },
      ),
    [data, t, i18n],
  )
  const keys = sourceArtifacts.flatMap((artifact) => Object.values(artifactPresentationKeys(artifact.id)))
  const { data: presentation = [], isLoading: presentationLoading } = useQuery({
    queryKey: ['artifactPresentation', projectId, ...keys],
    placeholderData: (previous, query) => (query?.queryKey[1] === projectId ? previous : undefined),
    query: toCompilableQuery(getArtifactPresentationRecords(db, keys)),
  })
  const artifacts = useMemo(() => {
    const loadedKeys = new Set(presentation.map((record) => record.key))
    // Keep the existing collection visible, but wait for new entries' deletion metadata.
    return applyArtifactPresentation(
      sourceArtifacts.filter((artifact) => loadedKeys.has(artifactPresentationKeys(artifact.id).deletedAt)),
      presentation,
    )
  }, [sourceArtifacts, presentation])
  return { artifacts: presentationLoading ? [] : artifacts, isLoading: isLoading || presentationLoading }
}

/** Live verified artifacts, for callers that do not need a loading indicator. */
export const useProjectArtifacts = (projectId: string | undefined) => useProjectArtifactsState(projectId).artifacts
