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
import { ThemeToggle } from '@/components/theme-toggle'

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
  // The macOS traffic lights (ending at ~x=68) are wider than the collapsed
  // 48px icon rail, so nudge the header content right of the overhang with
  // some breathing room so the agent selector pill doesn't crowd the buttons.
  const clearTrafficLights = isMacDesktop() && !isMobile && sidebarState === 'collapsed'
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

    return (
      <header
        {...dragProps}
        className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
      >
        {/* macOS traffic-light clearance is padding (not margin) so the left
            and right flex-1 columns resolve to identical widths and the agent
            selector stays viewport-centered. */}
        <div {...dragProps} className={cn('flex flex-1 items-center', isMacDesktop() && 'pl-20')}>
          {/* In the mobile layout the sidebar opens as an overlay on top of the
              content, so the toggle reads as a menu (burger) rather than a
              panel collapse. On macOS the button sits right of the traffic
              lights via the pl-20 above. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={toggleSidebar}
          >
            <Menu strokeWidth={1.5} className="size-[var(--icon-size-default)]" />
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
  // On the Tauri desktop app the expand toggle lives here while the sidebar is
  // collapsed to a rail — just right of the macOS traffic lights, the same
  // spot the collapse toggle occupies in the expanded sidebar's strip. On web
  // the toggle stays inside the sidebar itself.
  const showSidebarToggle = isTauri() && isDesktop() && sidebarState === 'collapsed'

  return (
    <header
      {...dragProps}
      className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
    >
      <div {...dragProps} className={cn('flex items-center gap-2', clearTrafficLights && 'ml-8')}>
        {showSidebarToggle && (
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={toggleSidebar}
          >
            <PanelLeft className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Expand Sidebar</span>
          </Button>
        )}
        {agentSelector}
      </div>
      <div {...dragProps} className="flex items-center gap-1">
        <ThemeToggle />
        <PowerSyncStatus />
      </div>
    </header>
  )
}
