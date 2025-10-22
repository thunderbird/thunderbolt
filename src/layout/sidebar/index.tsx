import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { Sidebar as SidebarRoot, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { deleteAllChatThreads, deleteChatThread, getAllChatThreads } from '@/dal'
import { useDebounce } from '@/hooks/use-debounce'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { ChatSidebarContent } from './chat-sidebar'
import { SettingsSidebarContent } from './settings-sidebar'

/**
 * Main sidebar component that orchestrates between chat and settings sidebars
 */
export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { setOpenMobile, state, toggleSidebar } = useSidebar()
  const isMobile = useIsMobile()
  const deleteAllChatsDialogRef = useRef<DeleteAllChatsDialogRef>(null)
  const deleteChatDialogRef = useRef<DeleteChatDialogRef>(null)
  const threadIdRef = useRef<string | null>(null)

  const { chatThreadId: currentChatThreadId } = useParams()

  // Simple route check: any /settings/* path triggers the settings sidebar variant on mobile
  const isSettingsRoute = location.pathname.startsWith('/settings')

  // Only use collapsed icon view on desktop, not mobile
  const isCollapsed = !isMobile && state === 'collapsed'

  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearchQuery = useDebounce(searchQuery, 300)
  const [showSearch, setShowSearch] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: false,
  })

  // Focus the search input when it becomes visible (only handles the case when opening while expanded)
  useEffect(() => {
    if (showSearch && searchInputRef.current && !isCollapsed) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    }
  }, [showSearch, isCollapsed])

  const { data } = useQuery({
    queryKey: ['chatThreads'],
    queryFn: getAllChatThreads,
    placeholderData: (previousData) => previousData,
  })

  const chatThreads = useMemo(() => {
    if (!data) {
      return []
    }

    return data.filter((thread) => thread.title?.toLowerCase().includes(debouncedSearchQuery?.toLowerCase()))
  }, [data, debouncedSearchQuery])

  const deleteChatMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await deleteChatThread(id)
    },
    onSuccess: () => {
      trackEvent('chat_delete', { chat_id: threadIdRef.current })
      deleteChatDialogRef.current?.close()
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      threadIdRef.current = null
    },
  })

  const deleteAllChatsMutation = useMutation({
    mutationFn: async () => {
      await deleteAllChatThreads()
    },
    onSuccess: async () => {
      trackEvent('chat_clear_all')
      deleteAllChatsDialogRef.current?.close()
      // Invalidate queries after the new thread is created
      await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate('/chats/new')
    },
  })

  const createNewChat = async (closeAfter: boolean = true) => {
    try {
      trackEvent('chat_new_clicked')
      navigate(`/chats/new`)
      // Close mobile sidebar after navigation
      if (closeAfter && isMobile) {
        setOpenMobile(false)
      }
    } catch (error) {
      console.error('Error creating new chat:', error)
    }
  }

  const handleChatClick = (threadId: string) => {
    navigate(`/chats/${threadId}`)

    // Track select chat event
    trackEvent('chat_select', { chat_id: threadId })

    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const handleSettingsNavigation = (path: string) => {
    navigate(path)
    if (isMobile) {
      // Close the sidebar after selecting a settings link
      setOpenMobile(false)
    }
  }

  const showSettingsMenu = () => {
    if (!isSettingsRoute) {
      navigate('/settings/preferences')
    }
  }

  const goToMainMenu = async () => {
    // Navigate to the main chat page
    const chatThreadId = currentChatThreadId || (chatThreads.length > 0 ? chatThreads[0].id : null)
    if (chatThreadId) {
      navigate(`/chats/${chatThreadId}`)
    } else {
      // If no chats, create a new one
      await createNewChat(false)
    }
  }

  const handleSearchClick = (e?: React.MouseEvent) => {
    e?.preventDefault()
    e?.stopPropagation()

    if (isCollapsed) {
      // If collapsed, expand the sidebar and show search
      toggleSidebar()
      setShowSearch(true)
      // Focus directly after DOM updates (useEffect won't run if showSearch was already true)
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    } else if (!showSearch) {
      // If already expanded and search is closed, open it (useEffect handles focus)
      setShowSearch(true)
    } else {
      // If already expanded and search is open, close it
      setShowSearch(false)
    }
  }

  // Render single sidebar with conditional content
  return (
    <SidebarRoot collapsible={isMobile ? 'offcanvas' : 'icon'}>
      <TooltipProvider>
        {isSettingsRoute ? (
          <SettingsSidebarContent onBackClick={goToMainMenu} onSettingsNavigate={handleSettingsNavigation} />
        ) : (
          <ChatSidebarContent
            isMobile={isMobile}
            isCollapsed={isCollapsed}
            chatThreads={chatThreads}
            currentChatThreadId={currentChatThreadId}
            searchQuery={searchQuery}
            debouncedSearchQuery={debouncedSearchQuery}
            showSearch={showSearch}
            searchInputRef={searchInputRef}
            deleteAllChatsMutation={deleteAllChatsMutation}
            deleteChatMutation={deleteChatMutation}
            deleteAllChatsDialogRef={deleteAllChatsDialogRef}
            deleteChatDialogRef={deleteChatDialogRef}
            threadIdRef={threadIdRef}
            showTasks={experimentalFeatureTasks.value}
            onCreateNewChat={() => createNewChat()}
            onChatClick={handleChatClick}
            onSearchClick={handleSearchClick}
            onSearchQueryChange={setSearchQuery}
            onSettingsClick={showSettingsMenu}
          />
        )}
      </TooltipProvider>
    </SidebarRoot>
  )
}
