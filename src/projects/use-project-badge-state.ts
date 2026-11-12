/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { selectMinimalMode } from '@/api/config-store'
import { useConfigCapability } from '@/hooks/use-config-capability'
import { useChatStore } from '@/chats/chat-store'
import { useProjects } from '@/dal/projects'
import type { Project } from '@/types'
import { useProjectMoveFeedback } from './use-project-move-feedback'

type ProjectBadgeDialog = { type: 'create' } | { type: 'edit'; project: Project }

/** Share project assignment between the draft session, persisted chat, and sidebar. */
export const useProjectBadgeState = (chatThreadId: string | null) => {
  const projectId = useChatStore((state) => (chatThreadId ? state.sessions.get(chatThreadId)?.projectId : undefined))
  const projects = useProjects()
  const minimalMode = useConfigCapability(selectMinimalMode)
  const { moveChat, error: moveError, clearError: clearMoveError, ...moveConfirmation } = useProjectMoveFeedback()
  const [dialog, setDialog] = useState<ProjectBadgeDialog | null>(null)
  const [isPending, startTransition] = useTransition()

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
    ...moveConfirmation,
  }
}
