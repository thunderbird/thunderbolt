/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { useProjects } from '@/dal/projects'
import type { Project } from '@/types'
import { useProjectMoveFeedback } from './use-project-move-feedback'

type ProjectBadgeDialog = { type: 'create' } | { type: 'edit' | 'move'; project: Project }

/** Share project assignment between the draft session, persisted chat, and sidebar. */
export const useProjectBadgeState = (chatThreadId: string | null) => {
  const projectId = useChatStore((state) => (chatThreadId ? state.sessions.get(chatThreadId)?.projectId : undefined))
  const projects = useProjects()
  const minimalMode = useConfigStore((state) => selectMinimalMode(state.config))
  const { moveChat, error: moveError, clearError: clearMoveError } = useProjectMoveFeedback()
  const [dialog, setDialog] = useState<ProjectBadgeDialog | null>(null)
  const [isPending, startTransition] = useTransition()

  // Close a stale prompt as soon as a synced deletion removes its target.
  // The write also validates against the database, before query updates arrive.
  if (dialog?.type === 'move' && !projects.some((candidate) => candidate.id === dialog.project.id)) {
    setDialog(null)
  }

  const selectProject = (nextProjectId: string | null) => {
    if (!chatThreadId || nextProjectId === projectId || isPending) {
      return
    }
    startTransition(async () => {
      await moveChat({ chatThreadId, projectId: nextProjectId })
    })
  }

  return {
    projects,
    moveError,
    clearMoveError,
    isVisible: !minimalMode && projectId !== undefined,
    project: projects.find((candidate) => candidate.id === projectId),
    dialog,
    openCreate: () => setDialog({ type: 'create' }),
    openEdit: (project: Project) => setDialog({ type: 'edit', project }),
    closeDialog: () => setDialog(null),
    isPending,
    selectProject,
    requestProjectChange: (nextProjectId: string) => {
      if (nextProjectId === projectId || isPending) {
        return
      }
      const target = projects.find((candidate) => candidate.id === nextProjectId)
      if (!target) {
        return
      }
      if (projectId) {
        setDialog({ type: 'move', project: target })
        return
      }
      selectProject(nextProjectId)
    },
  }
}
