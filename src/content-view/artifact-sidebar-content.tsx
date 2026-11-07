/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openArtifactChat } from '@/artifacts/navigation'
import { usePresentedArtifact } from '@/artifacts/use-artifacts'
import { Trans } from '@lingui/react/macro'
import { ArtifactSurface } from '@/artifacts/artifact-surface'
import { ArtifactControls } from '@/components/artifact/artifact-controls'
import { useChatStore } from '@/chats/chat-store'
import { setPendingPrompt } from '@/chats/pending-prompt-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { type ArtifactViewData } from './context'
import { ContentViewHeader } from './header'

type ArtifactSidebarContentProps = {
  data: ArtifactViewData
  onClose: () => void
}

/** The side-panel presentation shares its source renderer and controls with the other modes. */
const ResolvedArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
  const { chatThreadId: routeChatThreadId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const visibleChatId = () =>
    routeChatThreadId === 'new' ? useChatStore.getState().currentSessionId : (routeChatThreadId ?? params.get('chat'))
  const showInline = () => {
    onClose()
    if (data.source.kind === 'html' && data.chatThreadId) {
      if (routeChatThreadId && visibleChatId() === data.chatThreadId) {
        return
      }
      void navigate(`/chats/${encodeURIComponent(data.chatThreadId)}?view=chat`)
      return
    }
  }
  const openChat = (prompt?: string) => {
    const visible = visibleChatId()
    if (visible) {
      if (prompt) {
        setPendingPrompt(visible, prompt)
      }
      if (!routeChatThreadId) {
        onClose()
      }
      return
    }
    onClose()
    openArtifactChat(data, navigate, { prompt })
  }
  const askAbout = (passages: string[]) => {
    const visible = visibleChatId()
    const chatThreadId = data.chatThreadId ?? visible
    if (!chatThreadId) {
      onClose()
      openArtifactChat(data, navigate, { passages })
      return
    }
    for (const text of passages) {
      usePendingQuotesStore.getState().addQuote(chatThreadId, { text })
    }
    if (visible !== chatThreadId) {
      void navigate(`/chats/${encodeURIComponent(chatThreadId)}?view=chat`)
    }
    // On a workspace/library route, reveal the conversation after attaching the passage.
    if (!routeChatThreadId) {
      onClose()
    }
  }
  return (
    <div
      className="flex h-dvh flex-col md:pt-[var(--safe-area-top-padding)]"
      style={{ paddingBottom: 'var(--safe-area-bottom-padding)' }}
    >
      <ContentViewHeader
        title={data.title}
        onClose={onClose}
        className="md:bg-card"
        actions={
          <ArtifactControls
            artifact={data}
            display="sidebar"
            onOpenChat={openChat}
            onShowInline={data.chatThreadId ? showInline : undefined}
          />
        }
      />
      <div className="min-h-0 flex-1 bg-white">
        <ArtifactSurface artifact={data} onAsk={askAbout} onChatOpen={openChat} />
      </div>
    </div>
  )
}

/** Keep an open presentation current while respecting the delay before a new message is persisted. */
export const ArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
  const artifact = usePresentedArtifact(data)
  if (!artifact) {
    return (
      <div className="flex h-full flex-col">
        <ContentViewHeader title={data.title} onClose={onClose} />
        <p role="status" className="p-6 text-sm text-muted-foreground">
          <Trans>This artifact is no longer available.</Trans>
        </p>
      </div>
    )
  }
  return <ResolvedArtifactSidebarContent data={artifact} onClose={onClose} />
}
