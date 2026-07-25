/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentSelector } from '@/components/ui/agent-selector'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { useSidebar } from '@/components/ui/sidebar'
import { useAllAgents } from '@/dal'
import { builtInAgent } from '@/defaults/agents'
import { useIsMobile } from '@/hooks/use-mobile'
import { isMacDesktop, isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { PanelLeftRounded } from '@/components/icons/panel-left-rounded'
import { ArrowLeft, ArrowRight } from 'lucide-react'
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
  /** Mobile-only presentation. When set, the selector renders inside its own
   *  absolutely positioned wrapper: centered as a labeled pill on an empty new
   *  chat, and docked top-right as a circular icon button once the thread
   *  exists (or a send is in flight). Both states share one element, so the
   *  submit transition animates instead of remounting. */
  mobile?: { hasThread: boolean; dragProps: Record<string, unknown> }
}

const HeaderAgentSelector = ({
  chatInstance,
  selectedAgent,
  agents,
  onSelect,
  onAddAgent,
  mobile,
}: HeaderAgentSelectorProps) => {
  const { status } = useChat({ chat: chatInstance, experimental_throttle: statusOnlyThrottleMs })
  const isReplying = status === 'streaming' || status === 'submitted'
  // `status` flips to `submitted` synchronously on send, so the collapse starts
  // the moment the user submits — before the thread row lands in the store.
  // Existing chats mount with `hasThread` already true, so they render docked
  // top-right with no transition (CSS transitions don't run on first paint).
  const collapsed = mobile !== undefined && (mobile.hasThread || isReplying)

  const selector = (
    <AgentSelector
      selectedAgent={selectedAgent}
      agents={agents}
      onSelect={onSelect}
      onAddAgent={onAddAgent}
      disabled={isReplying}
      collapsed={collapsed}
    />
  )

  if (!mobile) {
    return selector
  }

  return (
    // Absolutely positioned so the macOS traffic-light clearance on the left
    // column can't push the centered state off-center. Docked: `left-full`
    // with a self-width translate pins the right edge 0.5rem from the header's
    // right — the percentage translate tracks the pill's own width as it
    // shrinks, so the slide and the collapse compose into one smooth motion.
    <div
      {...mobile.dragProps}
      className={cn(
        // Tailwind v4's translate utilities set the `translate` property (not
        // `transform`), so that's what must be in transition-property for the
        // slide to animate.
        'absolute top-2 z-10 flex items-center transition-[left,translate] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        collapsed ? 'left-full -translate-x-[calc(100%+0.5rem)]' : 'left-1/2 -translate-x-1/2',
      )}
    >
      {selector}
    </div>
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
  const { toggleSidebar, state: sidebarState, forceCollapsed } = useSidebar()
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

  const { chatInstance, selectedAgent, setSelectedAgent, chatThreadId, hasThread } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        chatInstance: session?.chatInstance,
        selectedAgent: session?.selectedAgent,
        setSelectedAgent: state.setSelectedAgent,
        chatThreadId: session?.id,
        hasThread: session?.chatThread != null,
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
    // One-shot deep link (see useConsumeNavState): lands with the Add Custom
    // Agent panel already open instead of on the bare list.
    navigate('/settings/agents', { state: { createAgent: '' } })
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
      mobile={isMobile ? { hasThread, dragProps } : undefined}
    />
  )

  // Mobile: sidebar toggle on the left; the agent selector positions itself
  // (centered pill on an empty new chat, top-right circle once the chat has
  // content — see HeaderAgentSelector).
  if (isMobile) {
    return (
      <header
        {...dragProps}
        className="relative flex h-[var(--touch-height-xl)] w-full items-start justify-between px-2 pt-2 flex-shrink-0"
      >
        <div {...dragProps} className={cn('flex flex-1 items-center', isMacDesktop() && 'pl-20')}>
          {/* The same panel glyph as the desktop toggle, so one icon means
              "sidebar" across both layouts even though mobile opens it as an
              overlay. On macOS the button sits right of the traffic lights via
              the pl-20 above. It wears the same muted circle as the overlay's
              own header controls (close X, ⋯), filled at rest so the tap target
              is visible without hover. */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(mutedIconButtonClass, mobileHeaderControlFillClass)}
            onClick={toggleSidebar}
          >
            <PanelLeftRounded className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>

        {agentSelector}

        {/* Empty right column — keeps the header row a drag surface on the
            Tauri desktop app. */}
        <div {...dragProps} className="flex flex-1 items-center" />
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
  // the toggle stays inside the sidebar itself. Hidden while the collapse is
  // forced by a narrow window — expanding is a no-op there.
  const showSidebarToggle = isTauriDesktop() && sidebarState === 'collapsed' && !forceCollapsed

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
