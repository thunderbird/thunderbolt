/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEmbeddedChatPanelState } from '@/chats/use-embedded-chat-panel-state'
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
  const chat = useEmbeddedChatPanelState()
  const contentView = useContentView()
  const canvas = useProjectArtifactCanvasState(artifact.html, artifact.title, !contentView.isOpen)
  const pins = useProjectArtifactPins(project.id, artifacts)
  const pinned = pins.pinnedIds.includes(artifact.id)
  const showChat = chat.openChatId === artifact.chatThreadId
  const showAside = !isMobile && contentView.isOpen
  const showPanel = showChat || showAside
  const openSourceChat = () => {
    contentView.close()
    chat.openExistingChat(artifact.chatThreadId)
  }
  const reveal = () => {
    contentView.close()
    chat.closeChat()
  }
  const askAbout = (passages: string[]) => {
    for (const text of passages) {
      usePendingQuotesStore.getState().addQuote(artifact.chatThreadId, { text })
    }
    openSourceChat()
  }
  return {
    artifactsDialog,
    chat,
    contentView,
    canvas,
    pins,
    pinned,
    showChat,
    showAside,
    showPanel,
    openSourceChat,
    reveal,
    askAbout,
  }
}
