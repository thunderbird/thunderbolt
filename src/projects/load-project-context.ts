/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves the project a chat belongs to into promptable content.
 *
 * Split from `buildProjectPromptSection` so the formatting/budgeting logic stays
 * a pure function: this module is the only part that touches the database.
 */

import { getProject, getProjectChatThreads } from '@/dal/projects'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getChatThread } from '@/dal/chat-threads'
import type { ProjectPromptContext } from './project-prompt'

/** Everything a send needs from the owning project: prompt content plus the
 *  sibling chats the search tool may look through. */
export type ProjectSendContext = {
  id: string
  prompt: ProjectPromptContext
  /** Sibling thread ids — the current chat is excluded, since its own history
   *  is already in context. */
  siblingThreadIds: string[]
  titleByThreadId: Map<string, string>
}

/**
 * Load the project context for a chat, or null when the chat has no project (or
 * the project was deleted out from under it — an orphaned chat simply loses the
 * project context rather than failing the send).
 */
export const loadProjectContextForThread = async (
  db: AnyDrizzleDatabase,
  chatThreadId: string | undefined,
): Promise<ProjectSendContext | null> => {
  if (!chatThreadId) {
    return null
  }
  const thread = await getChatThread(db, chatThreadId)
  if (!thread?.projectId) {
    return null
  }
  const project = await getProject(db, thread.projectId)
  if (!project) {
    return null
  }
  const siblings = (await getProjectChatThreads(db, project.id)) as { id: string; title: string | null }[]
  const titleByThreadId = new Map(siblings.map((thread) => [thread.id, thread.title ?? 'Untitled chat']))
  return {
    id: project.id,
    prompt: {
      name: project.name,
      instructions: project.instructions ?? null,
    },
    siblingThreadIds: siblings.map((thread) => thread.id).filter((id) => id !== chatThreadId),
    titleByThreadId,
  }
}
