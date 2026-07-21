/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentSelector } from '@/components/ui/agent-selector'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useAllAgents } from '@/dal'
import { builtInAgent } from '@/defaults/agents'
import { useIsMobile } from '@/hooks/use-mobile'
import { isMacDesktop, isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { PanelLeftRounded } from '@/components/icons/panel-left-rounded'
import { ArrowLeft, ArrowRight, Menu, MessageCirclePlus } from 'lucide-react'
import { useChatStore } from '@/chats/chat-store'
import type { ChatSession } from '@/chats/chat-store'
import { selectAllowCustomAgents, useConfigStore } from '@/api/config-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'
import { useHistoryCeiling } from '@/hooks/use-history-ceiling'
import { useChat } from '@ai-sdk/react'
import { statusOnlyThrottleMs } from '@/chats/chat-throttle'
import type { Agent } from '@/types/acp'

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

const headerIconButtonClass = 'size-[var(--touch-height-sm)] cursor-pointer text-muted-foreground hover:text-foreground'

/**
 * Back/forward history arrows for the Tauri desktop app, where there's no
 * browser chrome to navigate with. Web is skipped (the browser has its own
 * buttons) and so are mobile-width layouts (no room in the 3-column header).
 * Enabled state derives from react-router's history index (`history.state.idx`),
 * re-read on every location change.
 */
const HistoryNavButtons = () => {
  const navigate = useNavigate()
  // Subscribe to location so the enabled states recompute after navigation.
  useLocation()
  const { index, ceiling } = useHistoryCeiling()

  const canGoBack = index > 0
  const canGoForward = index < ceiling

  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className={headerIconButtonClass}
        disabled={!canGoBack}
        onClick={() => void navigate(-1)}
      >
        <ArrowLeft className="size-[var(--icon-size-default)]" />
        <span className="sr-only">Go back</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={headerIconButtonClass}
        disabled={!canGoForward}
        onClick={() => void navigate(1)}
      >
        <ArrowRight className="size-[var(--icon-size-default)]" />
        <span className="sr-only">Go forward</span>
      </Button>
    </div>
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
  const isDragRegionEnabled = isTauriDesktop()
  const dragProps = isDragRegionEnabled ? { 'data-tauri-drag-region': true } : {}
  // The macOS traffic lights (ending at ~x=68) are wider than the collapsed
  // 48px icon rail, so nudge the header content right of the overhang with
  // some breathing room so the agent selector pill doesn't crowd the buttons.
  const needsTrafficLightClearance = isMacDesktop() && !isMobile && sidebarState === 'collapsed'
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
        className="relative flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
      >
        <div {...dragProps} className={cn('flex flex-1 items-center', isMacDesktop() && 'pl-20')}>
          {/* In the mobile layout the sidebar opens as an overlay on top of the
              content, so the toggle reads as a menu (burger) rather than a
              panel collapse. On macOS the button sits right of the traffic
              lights via the pl-20 above. */}
          <Button variant="ghost" size="icon" className={headerIconButtonClass} onClick={toggleSidebar}>
            <Menu strokeWidth={1.5} className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>

        {/* Absolutely centered so the macOS traffic-light clearance on the
            left column can't push it off-center — flex sizing counts that
            padding as part of the column's outer width, so symmetric flex-1
            columns alone don't keep the middle truly centered. */}
        <div
          {...dragProps}
          className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2"
        >
          {agentSelector}
        </div>

        <div {...dragProps} className="flex flex-1 items-center gap-1 justify-end">
          {showNewChatButton && (
            <Button variant="ghost" size="icon" className={headerIconButtonClass} onClick={handleNewChat}>
              <MessageCirclePlus className="size-[var(--icon-size-default)]" />
              <span className="sr-only">New Chat</span>
            </Button>
          )}
        </div>
      </header>
    )
  }

  // Desktop: a single left-aligned group — optional expand toggle, history
  // arrows (Tauri app only), then the agent selector (fully left on web,
  // right of the arrows in the app). Theme and sync/account controls live in
  // the sidebar footer, so the right side stays empty (it remains a drag
  // surface on the Tauri desktop app).
  // On the Tauri desktop app the expand toggle lives here while the sidebar is
  // collapsed to a rail — just right of the macOS traffic lights, the same
  // spot the collapse toggle occupies in the expanded sidebar's strip. On web
  // the toggle stays inside the sidebar itself.
  const showSidebarToggle = isTauriDesktop() && sidebarState === 'collapsed'

  return (
    <header
      {...dragProps}
      className="relative flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
    >
      <div {...dragProps} className={cn('flex items-center gap-2', needsTrafficLightClearance && 'ml-8')}>
        {showSidebarToggle && (
          <Button variant="ghost" size="icon" className={headerIconButtonClass} onClick={toggleSidebar}>
            <PanelLeftRounded className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Expand Sidebar</span>
          </Button>
        )}
        {isTauriDesktop() && <HistoryNavButtons />}
        {agentSelector}
      </div>
    </header>
  )
}
