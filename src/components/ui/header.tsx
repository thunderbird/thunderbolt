import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { Menu, MessageCirclePlus } from 'lucide-react'
import { AgentSelector } from './agent-selector/agent-selector'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'
import { PowerSyncStatus } from '@/components/powersync-status'

/**
 * Reusable page header component with sidebar trigger and agent selector
 */
export const Header = () => {
  const { toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()

  const { agents, unavailableAgentIds, selectedAgent, setSelectedAgent, chatThreadId } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        agents: state.agents,
        unavailableAgentIds: state.unavailableAgentIds,
        selectedAgent: session?.agentConfig,
        setSelectedAgent: state.setSelectedAgent,
        chatThreadId: session?.id,
      }
    }),
  )

  const handleNewChat = () => {
    navigate('/chats/new')
  }

  const isChatRoute = location.pathname.startsWith('/chats')
  const showAgentSelector = isChatRoute && agents.length > 0

  const handleAgentChange = async (agentId: string) => {
    if (!agentId) {
      return
    }
    // Per ACP spec: a chat belongs to one agent. Switching agents creates a new chat.
    // Persist the agent selection, then navigate to a new chat which will use this agent.
    // Pass a unique timestamp in state to force a fresh session even if already on /chats/new.
    if (chatThreadId) {
      await setSelectedAgent(chatThreadId, agentId).catch(console.error)
    }
    navigate('/chats/new', { state: { agentSwitch: Date.now() } })
  }

  const agentSelector = showAgentSelector && (
    <AgentSelector
      agents={agents}
      disabledAgentIds={unavailableAgentIds}
      selectedAgent={selectedAgent ?? null}
      onAgentChange={handleAgentChange}
    />
  )

  // Mobile: 3-column layout with centered model selector
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

        <div className="flex shrink-0 items-center justify-center">{agentSelector}</div>

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

  // Desktop: Left-aligned with PowerSync status on the right
  return (
    <header className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0">
      <div className="flex items-center">{agentSelector}</div>
      <PowerSyncStatus />
    </header>
  )
}
