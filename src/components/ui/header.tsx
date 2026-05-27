/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentSelector } from '@/components/ui/agent-selector'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useAllAgents } from '@/dal'
import { builtInAgent } from '@/defaults/agents'
import { useIsMobile } from '@/hooks/use-mobile'
import { Menu, MessageCirclePlus } from 'lucide-react'
import { ModelSelector } from './model-selector'
import { useChatStore } from '@/chats/chat-store'
import type { ChatSession } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'
import { useChat } from '@ai-sdk/react'
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
  onManageAgents: () => void
}

const HeaderAgentSelector = ({
  chatInstance,
  selectedAgent,
  agents,
  onSelect,
  onManageAgents,
}: HeaderAgentSelectorProps) => {
  const { status } = useChat({ chat: chatInstance })
  const disabled = status === 'streaming' || status === 'submitted'

  return (
    <AgentSelector
      selectedAgent={selectedAgent}
      agents={agents}
      onSelect={onSelect}
      onManageAgents={onManageAgents}
      disabled={disabled}
    />
  )
}

/**
 * Reusable page header component with sidebar trigger, agent selector, and
 * model selector. The model selector renders only for the built-in agent —
 * ACP agents own their own model selection upstream.
 */
export const Header = () => {
  const { toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()
  const allAgents = useAllAgents()

  const {
    chatInstance,
    models,
    selectedModel,
    selectedAgent,
    setSelectedAgent,
    setSelectedModel,
    chatThread,
    chatThreadId,
  } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        chatInstance: session?.chatInstance,
        models: state.models,
        selectedModel: session?.selectedModel,
        selectedAgent: session?.selectedAgent,
        setSelectedAgent: state.setSelectedAgent,
        setSelectedModel: state.setSelectedModel,
        chatThread: session?.chatThread,
        chatThreadId: session?.id,
      }
    }),
  )

  // Derive the effective agent during render. If the persisted agent id no
  // longer resolves (deleted custom, unsynced system), fall back to built-in
  // without mutating state — `setSelectedAgent` only fires on explicit user
  // action via the dropdown.
  const effectiveAgent =
    (selectedAgent ? allAgents.find((a) => a.id === selectedAgent.id) : undefined) ?? selectedAgent ?? builtInAgent

  const isChatRoute = location.pathname.startsWith('/chats')
  const showAgentSelector = isChatRoute && chatInstance !== undefined && allAgents.length > 0
  const showModelSelector = isChatRoute && models.length > 0 && effectiveAgent.type === 'built-in'

  const handleAddModels = () => {
    navigate('/settings/models')
  }

  const handleManageAgents = () => {
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
      onManageAgents={handleManageAgents}
    />
  )

  const modelSelector = showModelSelector && (
    <ModelSelector
      models={models}
      selectedModel={selectedModel ?? null}
      chatThread={chatThread ?? null}
      onModelChange={(modelId) => {
        if (chatThreadId && modelId) {
          setSelectedModel(chatThreadId, modelId).catch(console.error)
        }
      }}
      onAddModels={handleAddModels}
    />
  )

  // Mobile: 3-column layout. Center holds Agent + Model selectors side by side.
  if (isMobile) {
    const showNewChatButton = isChatRoute && location.pathname !== '/chats/new'

    return (
      <header className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0">
        <div className="flex flex-1 items-center">
          <Button
            variant="ghost"
            size="icon"
            className="size-[var(--touch-height-sm)] cursor-pointer"
            onClick={toggleSidebar}
          >
            <Menu className="size-[var(--icon-size-default)]" />
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>

        <div className="flex shrink-0 items-center justify-center gap-2 min-w-0">
          {agentSelector}
          {modelSelector}
        </div>

        <div className="flex flex-1 items-center gap-1 justify-end">
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

  // Desktop: Agent + Model selectors left-aligned, PowerSync status right.
  return (
    <header className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0">
      <div className="flex items-center gap-2">
        {agentSelector}
        {modelSelector}
      </div>
      <PowerSyncStatus />
    </header>
  )
}
