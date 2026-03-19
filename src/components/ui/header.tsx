import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { Menu, MessageCirclePlus } from 'lucide-react'
import { ModelSelector } from './model-selector'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'
import { PowerSyncStatus } from '@/components/powersync-status'

/**
 * Reusable page header component with sidebar trigger and model selector
 */
export const Header = () => {
  const { toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()

  const { models, selectedModel, setSelectedModel, chatThread, chatThreadId } = useChatStore(
    useShallow((state) => {
      const session = state.sessions.get(state.currentSessionId ?? '')

      return {
        models: state.models,
        selectedModel: session?.selectedModel,
        setSelectedModel: state.setSelectedModel,
        chatThread: session?.chatThread,
        chatThreadId: session?.id,
      }
    }),
  )

  const handleAddModels = () => {
    navigate('/settings/models')
  }

  const handleNewChat = () => {
    navigate('/chats/new')
  }

  const isChatRoute = location.pathname.startsWith('/chats')
  const showModelSelector = isChatRoute && models.length > 0

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

  // Mobile: 3-column layout with centered model selector
  if (isMobile) {
    const showNewChatButton = isChatRoute && location.pathname !== '/chats/new'

    return (
      <header className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0 border-b border-border">
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

        <div className="flex shrink-0 items-center justify-center">{modelSelector}</div>

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
    <header className="flex h-[var(--touch-height-xl)] w-full items-center justify-between px-2 flex-shrink-0 border-b border-border">
      <div className="flex items-center">{modelSelector}</div>
      <PowerSyncStatus />
    </header>
  )
}
