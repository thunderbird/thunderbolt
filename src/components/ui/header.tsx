import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { Menu, SquarePen } from 'lucide-react'
import { ModelSelector } from './model-selector'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useNavigate, useLocation } from 'react-router'

/**
 * Reusable page header component with sidebar trigger and model selector
 */
export const Header = () => {
  const { toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()
  const location = useLocation()

  const { models, selectedModel, setSelectedModel, chatThread } = useChatStore(
    useShallow((state) => ({
      models: state.models,
      selectedModel: state.selectedModel,
      setSelectedModel: state.setSelectedModel,
      chatThread: state.chatThread,
    })),
  )

  const handleAddModels = () => {
    navigate('/settings/models')
  }

  const handleNewChat = () => {
    navigate('/chats/new')
  }

  const isChatRoute = location.pathname.startsWith('/chats')
  const showModelSelector = isChatRoute && models.length > 0

  // Mobile: 3-column layout with centered model selector
  // Desktop: Left-aligned model selector
  if (isMobile) {
    return (
      <header className="flex h-12 w-full items-center justify-between px-2 flex-shrink-0 border-b border-border">
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer" onClick={toggleSidebar}>
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>

        <div className="flex items-center justify-center flex-1">
          {showModelSelector && (
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              chatThread={chatThread}
              onModelChange={setSelectedModel}
              onAddModels={handleAddModels}
            />
          )}
        </div>

        <div className="flex items-center">
          {isChatRoute && (
            <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer" onClick={handleNewChat}>
              <SquarePen className="h-5 w-5" />
              <span className="sr-only">New Chat</span>
            </Button>
          )}
        </div>
      </header>
    )
  }

  // Desktop: Left-aligned
  return (
    <header className="flex h-12 w-full items-center px-2 flex-shrink-0 border-b border-border">
      {showModelSelector && (
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          chatThread={chatThread}
          onModelChange={setSelectedModel}
          onAddModels={handleAddModels}
        />
      )}
    </header>
  )
}
