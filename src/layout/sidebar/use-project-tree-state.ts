/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useState, useTransition } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useSidebar } from '@/components/ui/sidebar'
import { useChatStore } from '@/chats/chat-store'
import { useProjects, setProjectPinned } from '@/dal/projects'
import { useDatabase } from '@/contexts'
import type { Project } from '@/types'
import type { ProjectDeletionTarget } from '@/projects/project-delete-dialog'
import type { ProjectActionHandlers } from '@/projects/project-action-menu-items'
import { projectTreeReducer } from '@/projects/project-tree-state'
import { useSidebarPreviewState } from './use-sidebar-preview-state'
import type { ChatThread } from './types'

type ProjectDialog =
  | { type: 'create' }
  | { type: 'edit'; project: Project }
  | { type: 'delete'; target: ProjectDeletionTarget }

/** Keep project expansion, incremental disclosure, and creation navigation together. */
export const useProjectTreeState = (chatThreads: ChatThread[], currentChatThreadId?: string) => {
  const projects = useProjects()
  const db = useDatabase()
  const [, startTransition] = useTransition()
  const createNewChat = useCreateNewChat()
  const navigate = useNavigate()
  const { closeMobileSidebar } = useSidebar()
  const [params] = useSearchParams()
  const draftProjectId = useChatStore((store) => {
    if (currentChatThreadId !== 'new') {
      return undefined
    }
    const session = store.sessions.get(store.currentSessionId ?? '')
    return session?.chatThread ? undefined : session?.projectId
  })
  // The URL seeds a new chat, but its picker can change or clear that assignment.
  // Only fall back before hydration: null is an explicit removal from the project.
  const activeId =
    draftProjectId !== undefined
      ? draftProjectId
      : (chatThreads.find((thread) => thread.id === currentChatThreadId)?.projectId ?? params.get('projectId'))
  const [state, dispatch] = useReducer(projectTreeReducer, { activeId, expanded: new Set(activeId ? [activeId] : []) })
  const [dialog, setDialog] = useState<ProjectDialog | null>(null)
  const [storedExpanded, setSectionExpanded] = useLocalStorage('sidebar.projects.expanded', 'true')
  const sectionExpanded = storedExpanded !== 'false'
  if (state.activeId !== activeId) {
    dispatch({ type: 'navigate', id: activeId })
  }
  const projectList = useSidebarPreviewState(projects, activeId)

  return {
    projects,
    activeId,
    state,
    projectList,
    dialog,
    sectionExpanded,
    openCreateDialog: () => setDialog({ type: 'create' }),
    openDeleteAll: () => setDialog({ type: 'delete', target: { scope: 'all' } }),
    closeDialog: () => setDialog(null),
    projectsDeleted: async (target: ProjectDeletionTarget) => {
      if (activeId && (target.scope === 'all' || activeId === target.projectId)) {
        await closeMobileSidebar()
        navigate('/chats/new')
      }
    },
    toggleSection: () => setSectionExpanded(sectionExpanded ? 'false' : 'true'),
    toggleProject: (id: string) => dispatch({ type: 'toggle', id }),
    getProjectActions: (project: Project): ProjectActionHandlers => ({
      onNewChat: async () => {
        await closeMobileSidebar()
        createNewChat(project.id)
      },
      onTogglePin: () =>
        startTransition(async () => {
          await setProjectPinned(db, project.id, project.pinnedOrder === null ? 0 : null)
        }),
      onEdit: () => setDialog({ type: 'edit', project }),
      onDelete: () => setDialog({ type: 'delete', target: { scope: 'one', projectId: project.id } }),
    }),
    projectCreated: async (id: string) => {
      setSectionExpanded('true')
      await closeMobileSidebar()
      createNewChat(id)
    },
  }
}
