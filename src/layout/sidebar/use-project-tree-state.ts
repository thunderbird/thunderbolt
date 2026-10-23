/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useSidebar } from '@/components/ui/sidebar'
import { useProjects } from '@/dal/projects'
import { projectTreeReducer } from '@/projects/project-tree-state'
import { useSidebarPreviewState } from './use-sidebar-preview-state'
import type { ChatThread } from './types'

/** Keep project expansion, incremental disclosure, and creation navigation together. */
export const useProjectTreeState = (chatThreads: ChatThread[], currentChatThreadId?: string) => {
  const projects = useProjects()
  const createNewChat = useCreateNewChat()
  const navigate = useNavigate()
  const { closeMobileSidebar } = useSidebar()
  const [params] = useSearchParams()
  const { projectId } = useParams()
  const activeId =
    projectId ?? chatThreads.find((thread) => thread.id === currentChatThreadId)?.projectId ?? params.get('projectId')
  const [state, dispatch] = useReducer(projectTreeReducer, { activeId, expanded: new Set(activeId ? [activeId] : []) })
  const [dialog, setDialog] = useState<'create' | 'deleteAll' | null>(null)
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
    openCreateDialog: () => setDialog('create'),
    openDeleteAll: () => setDialog('deleteAll'),
    closeDialog: () => setDialog(null),
    projectsDeleted: async () => {
      if (activeId) {
        await closeMobileSidebar()
        navigate('/chats/new')
      }
    },
    toggleSection: () => setSectionExpanded(sectionExpanded ? 'false' : 'true'),
    toggleProject: (id: string) => dispatch({ type: 'toggle', id }),
    projectCreated: async (id: string) => {
      setSectionExpanded('true')
      dispatch({ type: 'navigate', id })
      await closeMobileSidebar()
      createNewChat(id)
    },
  }
}
