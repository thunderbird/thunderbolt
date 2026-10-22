/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useProjects } from '@/dal/projects'
import { projectTreeReducer } from '@/projects/project-tree-state'
import { useSidebarPreviewState } from './use-sidebar-preview-state'
import type { ChatThread } from './types'

/** Keep project expansion, incremental disclosure, and creation navigation together. */
export const useProjectTreeState = (chatThreads: ChatThread[], currentChatThreadId?: string) => {
  const projects = useProjects()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { projectId } = useParams()
  const activeId =
    projectId ?? chatThreads.find((thread) => thread.id === currentChatThreadId)?.projectId ?? params.get('projectId')
  const [state, dispatch] = useReducer(projectTreeReducer, { activeId, expanded: new Set(activeId ? [activeId] : []) })
  const [editorOpen, setEditorOpen] = useState(false)
  const [sectionExpanded, setSectionExpanded] = useState(true)
  if (state.activeId !== activeId) {
    dispatch({ type: 'navigate', id: activeId })
  }
  const projectList = useSidebarPreviewState(projects, activeId)

  return {
    projects,
    activeId,
    state,
    projectList,
    editorOpen,
    sectionExpanded,
    openEditor: () => setEditorOpen(true),
    closeEditor: () => setEditorOpen(false),
    toggleSection: () => setSectionExpanded((expanded) => !expanded),
    toggleProject: (id: string) => dispatch({ type: 'toggle', id }),
    projectCreated: (id: string) => {
      setSectionExpanded(true)
      dispatch({ type: 'navigate', id })
      navigate(`/chats/new?projectId=${id}`)
    },
  }
}
