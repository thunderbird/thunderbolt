/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'

import { AgentSelector } from '@/components/ui/agent-selector'
import { ProjectBadge } from '@/projects/project-badge'
import { useCreateItem } from '@/components/create-item/context'
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

/** Marks an element as part of the Tauri desktop window's drag surface (empty
 *  on web/mobile where no custom title bar exists). */
type TauriDragProps = { 'data-tauri-drag-region'?: boolean }

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
  mobile?: { hasThread: boolean; dragProps: TauriDragProps }
  /** Rendered immediately left of the selector, inside its positioned wrapper on
   *  mobile so it docks with the pill instead of being laid out against a header
   *  column the pill has left. */
  leading?: ReactNode
}

const HeaderAgentSelector = ({
  chatInstance,
  selectedAgent,
  agents,
  onSelect,
  onAddAgent,
  mobile,
  leading,
}: HeaderAgentSelectorProps) => {
  const { status } = useChat({ chat: chatInstance, experimental_throttle: statusOnlyThrottleMs })
  const isReplying = status === 'streaming' || status === 'submitted'
  // `status` flips to `submitted` synchronously on send, so the transition starts
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
    // column can't push the centered state off-center. Docked: a translate of
    // half the header width (50cqw — the header is a size container) minus the
    // pill's own width pins the right edge flush with the content edge (cqw is
    // content-box based, so the header's px-2 padding provides the gap).
    //
    // Only `translate` transitions — `left` stays fixed. Animating `left`
    // re-runs layout on the main thread every frame, and this slide fires at
    // the busiest main-thread moment in the app (first send mounts the message
    // list), which made it visibly stutter. A translate-only transition runs
    // on the compositor and stays smooth regardless of main-thread load.
    //
    // The trigger width stays fixed throughout. Its labeled pill and logo-only
    // circle crossfade internally (see AgentSelector), so this wrapper only
    // animates translate and both directions remain compositor-driven.
    <div
      {...mobile.dragProps}
      className={cn(
        'absolute top-2 left-1/2 z-10 flex items-center transition-[translate] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        collapsed ? '[translate:calc(50cqw-100%)_0]' : '[translate:-50%_0]',
      )}
    >
      {/* Inside the wrapper, so the docked translate (which pins the group's
          right edge to the content edge) accounts for it and the two circles
          travel together. */}
      {leading}
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
        <span className="sr-only">
          <Trans>Go back</Trans>
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={headerIconButtonClass}
        disabled={!canGoForward}
        onClick={() => void navigate(1)}
      >
        <ArrowRight className="size-[var(--icon-size-default)]" />
        <span className="sr-only">
          <Trans>Go forward</Trans>
        </span>
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
  // Both desktop apps hide the native title bar (macOS overlays it with traffic
  // lights; Windows/Linux are frameless), so the header row doubles as the drag
  // surface — including when the viewport is narrow enough to fall into the
  // mobile-style layout.
  const isDragRegionEnabled = isTauriDesktop()
  const dragProps: TauriDragProps = isDragRegionEnabled ? { 'data-tauri-drag-region': true } : {}
  // The macOS traffic lights (ending at ~x=68) are wider than the collapsed
  // 48px icon rail, so nudge the header content right of the overhang with
  // some breathing room so the agent selector pill doesn't crowd the buttons.
  const needsTrafficLightClearance = isMacDesktop() && !isMobile && sidebarState === 'collapsed'
  const { openCreateItem } = useCreateItem()
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
    openCreateItem({ kind: 'agent' })
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
      leading={isChatRoute ? <ProjectBadge chatThreadId={chatThreadId ?? null} iconOnly /> : undefined}
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
        // `@container` lets the agent pill's docked translate use 50cqw (half
        // the header width) so its slide can be translate-only (see above).
        className="@container relative flex h-[var(--touch-height-xl)] w-full items-start justify-between px-2 pt-2 flex-shrink-0"
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
            <span className="sr-only">
              <Trans>Toggle Sidebar</Trans>
            </span>
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
  // On macOS the expand toggle lives here while the sidebar is collapsed to a
  // rail — just right of the traffic lights, the same spot the collapse toggle
  // occupies in the expanded sidebar's strip. On web and the Windows/Linux apps
  // the toggle stays inside the sidebar itself. Hidden while the collapse is
  // forced by a narrow window — expanding is a no-op there.
  const showSidebarToggle = isMacDesktop() && sidebarState === 'collapsed' && !forceCollapsed

  return (
    <header
      {...dragProps}
      className="relative flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0"
    >
      <div {...dragProps} className={cn('flex items-center gap-2', needsTrafficLightClearance && 'ml-8')}>
        {showSidebarToggle && (
          <Button variant="ghost" size="icon" className={headerIconButtonClass} onClick={toggleSidebar}>
            <PanelLeftRounded className="size-[var(--icon-size-default)]" />
            <span className="sr-only">
              <Trans>Expand Sidebar</Trans>
            </span>
          </Button>
        )}
        {isTauriDesktop() && <HistoryNavButtons />}
        {agentSelector}
        {/* Beside the agent selector rather than centred: it groups with the other
            "what this chat is" controls. Desktop only — the mobile header positions
            the agent pill absolutely and has no room next to it. */}
        {isChatRoute && <ProjectBadge chatThreadId={chatThreadId ?? null} />}
      </div>
    </header>
  )
}
