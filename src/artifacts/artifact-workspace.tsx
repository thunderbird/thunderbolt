/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { GroupImperativeHandle } from 'react-resizable-panels'
import { useLocation, useNavigate } from 'react-router'
import { AnimatePresence, m } from 'framer-motion'
import ChatUI from '@/components/chat/chat-ui'
import { ChatHydrateHandler } from '@/chats/detail'
import { ArtifactControls } from '@/components/artifact/artifact-controls'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ActiveContentView } from '@/content-view/active-content-view'
import { ContentViewHeader } from '@/content-view/header'
import { useContentView } from '@/content-view/context'
import { useMiniAppChats } from '@/dal/mini-app-chats'
import { useIsMobile } from '@/hooks/use-mobile'
import { sharedHeaderHasControls } from '@/layout/shared-header'
import { isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { MiniAppChatHistory } from '@/mini-apps/mini-app-chat-history'
import { useMiniAppChatPanelState } from '@/mini-apps/use-mini-app-chat-panel-state'
import { useAsideYieldsToChat } from '@/mini-apps/use-aside-yields-to-chat'
import { appPanelMinWidth, chatPanelMinWidth, useChatSplitFits } from '@/mini-apps/use-chat-split'
import type { Artifact } from './artifact'
import { ArtifactSurface } from './artifact-surface'
import { artifactChatOrigin, artifactDraftChatId } from './navigation'

/** One conversation workspace for either artifact source and either panel arrangement. */
export const ArtifactWorkspace = ({ artifact }: { artifact: Artifact }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const [sidebar, setSidebar] = useState(false)
  const panel = useMiniAppChatPanelState(artifactDraftChatId(location.state))
  const { isMobile } = useIsMobile()
  const { state, isOpen: isAsideOpen, close: closeAside } = useContentView()
  useAsideYieldsToChat({ isChatOpen: panel.isChatOpen, isAsideOpen, closeAside })
  const [splitContainer, setSplitContainer] = useState<HTMLDivElement | null>(null)
  const splitFits = useChatSplitFits(splitContainer) && !isMobile
  const origin = artifactChatOrigin(artifact)
  const chats = useMiniAppChats(origin, artifact.chatThreadId)
  const sameArtifactInAside = state.type === 'artifact' && state.data.id === artifact.id
  const inset = sharedHeaderHasControls({ pathname: location.pathname, isMobile, isDesktopApp: isTauriDesktop() })

  const showInSidebar = () => {
    closeAside()
    panel.openChat()
    setSidebar(true)
  }
  const showInline = () => {
    closeAside()
    if (artifact.chatThreadId) {
      void navigate(`/chats/${encodeURIComponent(artifact.chatThreadId)}?view=chat`)
    }
  }
  const artifactPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.title}</span>
        <ArtifactControls
          artifact={artifact}
          display={sidebar ? 'sidebar' : 'fullscreen'}
          onShowInline={artifact.chatThreadId ? showInline : undefined}
          onOpenInPanel={showInSidebar}
          onOpenFullScreen={() => setSidebar(false)}
        />
        {!panel.isChatOpen && (
          <Button variant="ghost" size="sm" onClick={() => panel.openChat()}>
            <MessageSquare className="size-4" />
            <Trans>Chat</Trans>
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {sameArtifactInAside ? (
          <div className="flex h-full items-center justify-center">
            <Button variant="ghost" onClick={closeAside}>
              <Trans>Show here</Trans>
            </Button>
          </div>
        ) : (
          <ArtifactSurface artifact={artifact} onAsk={panel.attachToComposer} onChatOpen={panel.openChat} />
        )}
      </div>
    </div>
  )
  const chatPane = (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {panel.isChatOpen && (
        <div className="flex h-full min-h-0 flex-col" inert={isAsideOpen}>
          <ContentViewHeader
            title={artifact.title}
            onClose={panel.closeChat}
            actions={
              <MiniAppChatHistory chats={chats} onOpenChat={panel.openExistingChat} onNewChat={panel.startNewChat} />
            }
          />
          <div className="min-h-0 flex-1">
            <ChatHydrateHandler
              key={panel.openChatId!}
              existingId={panel.draftChatId ? null : panel.openChatId}
              newChatId={panel.openChatId!}
              projectId={null}
              miniAppId={origin}
              onCreated={panel.handleChatCreated}
            >
              <ChatUI />
            </ChatHydrateHandler>
          </div>
        </div>
      )}
      <AnimatePresence initial={false}>
        {isAsideOpen && !isMobile && (
          <m.div
            key="aside"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 z-10 flex flex-col border-l bg-background will-change-transform"
          >
            <ActiveContentView />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
  const showCompanion = panel.isChatOpen || (isAsideOpen && !isMobile)

  const groupRef = useRef<GroupImperativeHandle>(null)
  // Synchronize the external panel layout without reparenting either iframe or conversation.
  // Reparenting an iframe reloads its document even when its React key is unchanged.
  useEffect(() => {
    const chatSize = !showCompanion ? 0 : !splitFits ? 100 : sidebar ? 66 : 34
    groupRef.current?.setLayout({ 'artifact-chat': chatSize, artifact: 100 - chatSize })
  }, [showCompanion, splitFits, sidebar])

  return (
    <div
      ref={setSplitContainer}
      className={cn('flex h-full min-h-0 w-full flex-col', inset && 'pt-[var(--header-inset)]')}
    >
      <ResizablePanelGroup orientation="horizontal" groupRef={groupRef} disabled={!splitFits}>
        <ResizablePanel
          id="artifact-chat"
          defaultSize="0%"
          minSize={splitFits ? `${chatPanelMinWidth}px` : '0%'}
          collapsible
          collapsedSize="0%"
        >
          <div className="h-full" inert={!showCompanion} aria-hidden={!showCompanion}>
            {chatPane}
          </div>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          disabled={!splitFits || !showCompanion}
          className={!splitFits || !showCompanion ? 'hidden' : undefined}
        />
        <ResizablePanel
          id="artifact"
          defaultSize="100%"
          minSize={splitFits ? `${appPanelMinWidth}px` : '0%'}
          collapsible
          collapsedSize="0%"
        >
          <div className="h-full" inert={!splitFits && showCompanion} aria-hidden={!splitFits && showCompanion}>
            {artifactPane}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
