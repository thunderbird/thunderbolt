/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSearchParams } from 'react-router'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { useContentView } from '@/content-view/context'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Project } from '@/types'
import type { ProjectArtifact } from './project-artifacts-data'
import { useProjectArtifactPins } from './use-project-artifact-pins'
import { useProjectArtifactCanvasState } from './use-project-artifact-canvas-state'
import { useProjectArtifactsDialog } from './use-project-artifacts-dialog'

/** Coordinate the artifact canvas, source conversation, and quote handoff. */
export const useProjectArtifactWorkspaceState = (
  project: Project,
  artifact: ProjectArtifact,
  artifacts: ProjectArtifact[],
) => {
  const artifactsDialog = useProjectArtifactsDialog()
  const { isMobile } = useIsMobile()
  const [params, setParams] = useSearchParams()
  const contentView = useContentView()
  const canvas = useProjectArtifactCanvasState(artifact.html, artifact.title, !contentView.isOpen)
  const pins = useProjectArtifactPins(project.id, artifacts)
  const pinned = pins.pinnedIds.includes(artifact.id)
  const showChat = params.get('chat') === artifact.chatThreadId
  const showAside = !isMobile && contentView.isOpen
  const showPanel = showChat || showAside
  const setSourceChatOpen = (open: boolean) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (open) {
          next.set('chat', artifact.chatThreadId)
        } else {
          next.delete('chat')
        }
        return next
      },
      { replace: true },
    )
  }
  const closeSourceChat = () => setSourceChatOpen(false)
  const openSourceChat = () => {
    contentView.close()
    setSourceChatOpen(true)
  }
  const reveal = () => {
    contentView.close()
    closeSourceChat()
  }
  const askAbout = (passages: string[]) => {
    for (const text of passages) {
      usePendingQuotesStore.getState().addQuote(artifact.chatThreadId, { text })
    }
    openSourceChat()
  }
  return {
    artifactsDialog,
    contentView,
    canvas,
    pins,
    pinned,
    showChat,
    showAside,
    showPanel,
    openSourceChat,
    closeSourceChat,
    reveal,
    askAbout,
  }
}
