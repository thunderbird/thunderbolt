/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Moving a chat into (or out of) a project.
 *
 * Shared by the two entry points — dragging a chat onto a sidebar project row,
 * and the chat's own "Move" action — because the write is more than
 * one column: the live session's badge has to be updated and the sidebar list
 * re-read. Two copies of that would drift.
 *
 * The work is a plain function over injected dependencies, with a hook that wires
 * the real ones. That keeps it testable without `mock.module`, which bun installs
 * worker-wide and which would strip other exports from `@/contexts` and the chat
 * store for every sibling test in the same worker.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/chats/chat-store'
import { withChatThreadWrite } from '@/chats/chat-thread-write'
import { useDatabase } from '@/contexts'
import { setChatThreadProject } from '@/dal/projects'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { ChatDrop } from '@/projects/chat-drop'

export type MoveChatDeps = {
  db: AnyDrizzleDatabase
  setProject: typeof setChatThreadProject
  /** Update the live session's badge; skipped when the chat isn't open. */
  updateOpenSession: (chatThreadId: string, projectId: string | null) => void
  /** Re-read the sidebar's chat rows. */
  refreshChatList: () => Promise<void>
}

export const moveChatToProject = async ({ chatThreadId, projectId }: ChatDrop, deps: MoveChatDeps): Promise<void> => {
  await withChatThreadWrite(chatThreadId, async () => {
    const assigned = await deps.setProject(deps.db, chatThreadId, projectId)
    if (assigned) {
      deps.updateOpenSession(chatThreadId, projectId)
    }
  })
  // Only the chat rows need a nudge; the project counts are a reactive PowerSync
  // query and update themselves.
  await deps.refreshChatList()
}

export const useMoveChatToProject = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()

  return (drop: ChatDrop): Promise<void> =>
    moveChatToProject(drop, {
      db,
      setProject: setChatThreadProject,
      // Guarded because a session exists only for a chat opened this run, and
      // `updateSession` throws on an unknown id.
      updateOpenSession: (chatThreadId, projectId) => {
        const store = useChatStore.getState()
        if (store.sessions.has(chatThreadId)) {
          store.updateSession(chatThreadId, { projectId })
        }
      },
      refreshChatList: () => queryClient.invalidateQueries({ queryKey: ['chatThreads'] }),
    })
}
