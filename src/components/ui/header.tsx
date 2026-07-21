/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentSelector } from '@/components/ui/agent-selector'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useAllAgents } from '@/dal'
import { builtInAgent } from '@/defaults/agents'
import { useIsMobile } from '@/hooks/use-mobile'
import { isDesktop, isMacDesktop, isTauri } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { Menu, MessageCirclePlus, PanelLeft } from 'lucide-react'
import { useChatStore } from '@/chats/chat-store'
import type { ChatSession } from '@/chats/chat-store'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'
import { useChat } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import type { Agent } from '@/types/acp'
import { PowerSyncStatus } from '@/components/powersync-status'

/** Subscribes to the active chat instance's status to disable the agent
 *  selector while a reply is streaming. Pulled into its own component so
 *  `useChat` is only mounted when a session exists. */
type HeaderAgentSelectorProps = {
  chatInstance: ChatSession['chatInstance']
  selectedAgent: Agent
  agents: Agent[]
  onSelect: (agent: Agent) => void
  /** Omitted when the deployment forbids custom agents — the selector then hides
   *  its "Add Agent" footer. */
  onAddAgent?: () => void
}

const HeaderAgentSelector = ({
  chatInstance,
  selectedAgent,
  agents,
  onSelect,
  onAddAgent,
}: HeaderAgentSelectorProps) => {
  const { status } = useChat({ chat: chatInstance, experimental_throttle: statusOnlyThrottleMs })
  const disabled = status === 'streaming' || status === 'submitted'

  return (
    <AgentSelector
      selectedAgent={selectedAgent}
      agents={agents}
      onSelect={onSelect}
      onAddAgent={onAddAgent}
      disabled={disabled}
    />
  )
}

/**
 * Reusable page header component with sidebar trigger and agent selector. Model
 * selection lives in the chat composer (next to the mode picker), not here.
 */
export const Header = () => {
  const { toggleSidebar, state: sidebarState } = useSidebar()
  const { isMobile } = useIsMobile()
  // Tauri desktop hides the OS title bar; the header row itself doubles as
  // the drag surface — including when the viewport is narrow enough to fall
  // into the mobile-style layout. `<WindowControls />` renders its Win/Linux
  // buttons inline on the right (self-nulls on macOS/web).
  const enableDragRegion = isTauri() && isDesktop()
  const dragProps = enableDragRegion ? { 'data-tauri-drag-region': true } : {}
  // Tauri desktop fully hides the sidebar on collapse (see layout/sidebar/
  // index.tsx) — surface a re-open toggle in the header in that state so it
  // stays discoverable.
  const showReopenSidebarButton = isTauri() && isDesktop() && !isMobile && sidebarState === 'collapsed'
  const navigate = useNavigate()
  const location = useLocation()
  const allAgents = useAllAgents()
  const allowCustomAgents = useConfigStore((state) => selectAllowCustomAgents(state.config))

  const { chatInstance, selectedAgent, setSelectedAgent, chatThreadId } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        chatInstance: session?.chatInstance,
        selectedAgent: session?.selectedAgent,
        setSelectedAgent: state.setSelectedAgent,
        chatThreadId: session?.id,
      }
    }),
  )

  // Prefer the session's already-resolved agent (hydration resolves the
  // persisted thread agentId into `selectedAgent`). Re-searching `allAgents`
  // here would show built-in on first render while `useAllAgents` is still
  // loading and the list is empty. Fall back to built-in only when the thread
  // has no agent.
  const effectiveAgent = selectedAgent ?? builtInAgent

  const isChatRoute = location.pathname.startsWith('/chats')
  const showAgentSelector = isChatRoute && chatInstance !== undefined && allAgents.length > 0

  const handleAddAgent = () => {
    navigate('/settings/agents')
  }

  const handleNewChat = () => {
    navigate('/chats/new')
  }

  const handleAgentSelect = (agent: Agent) => {
    if (chatThreadId) {
      setSelectedAgent(chatThreadId, agent).catch(console.error)
    }
  }

  const agentSelector = showAgentSelector && chatInstance && (
    <HeaderAgentSelector
      chatInstance={chatInstance}
      selectedAgent={effectiveAgent}
      agents={allAgents}
      onSelect={handleAgentSelect}
      onAddAgent={allowCustomAgents ? handleAddAgent : undefined}
    />
  )

  // Mobile: 3-column layout. Center holds the agent selector.
  if (isMobile) {
    const showNewChatButton = isChatRoute && location.pathname !== '/chats/new'
    // A Tauri desktop window resized narrow enough to trigger this branch has
    // the sidebar collapsed into offcanvas and needs a way back — use the same
    // PanelLeft icon the sidebar uses to toggle itself. On macOS the toggle
    // has to clear the OS traffic lights sitting at the top-left of the window.
    const isTauriDesktopNarrow = isTauri() && isDesktop()
    const ToggleIcon = isTauriDesktopNarrow ? PanelLeft : Menu

    return (
      <header
        {...dragProps}
        className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
      >
        <div {...dragProps} className={cn('flex flex-1 items-center', isMacDesktop() && 'ml-20')}>
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer"
            onClick={toggleSidebar}
          >
            <ToggleIcon className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>

        <div {...dragProps} className="flex shrink-0 items-center justify-center gap-2 min-w-0">
          {agentSelector}
        </div>

        <div {...dragProps} className="flex flex-1 items-center gap-1 justify-end">
          {showNewChatButton && (
            <Button
              variant="ghost"
              size="icon"
              className="size-[var(--touch-height-sm)] cursor-pointer"
              onClick={handleNewChat}
            >
              <MessageCirclePlus className="size-[var(--icon-size-default)]" />
              <span className="sr-only">New Chat</span>
            </Button>
          )}
        </div>
      </header>
    )
  }

  // Desktop: Agent selector left-aligned, PowerSync status right.
  return (
    <header
      {...dragProps}
      className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
    >
      <div
        {...dragProps}
        className={cn('flex items-center gap-2', showReopenSidebarButton && isMacDesktop() && 'ml-20')}
      >
        {showReopenSidebarButton && (
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer"
            onClick={toggleSidebar}
          >
            <PanelLeft className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Open Sidebar</span>
          </Button>
        )}
        {agentSelector}
      </div>
      <div {...dragProps} className="flex items-center gap-2">
        <PowerSyncStatus />
      </div>
    </header>
  )
}
