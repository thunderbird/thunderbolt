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
  const { isMobile } = useIsMobile()
  const deleteAllChatsDialogRef = useRef<DeleteAllChatsDialogRef>(null)
  const deleteChatDialogRef = useRef<DeleteChatDialogRef>(null)
  const threadIdRef = useRef<string | null>(null)
  const lastChatPathRef = useRef<string | null>(null)

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

  useEffect(() => {
    if (location.pathname.startsWith('/chats/')) {
      lastChatPathRef.current = location.pathname
    }
  }, [location.pathname])

  useEffect(() => {
    if (showSearch && searchInputRef.current && !isCollapsed) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    }
  }, [showSearch, isCollapsed])

  const { data, isPending } = useQuery({
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
    onSuccess: async () => {
      const deletedChatId = threadIdRef.current
      trackEvent('chat_delete', { chat_id: deletedChatId })
      deleteChatDialogRef.current?.close()
      await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      threadIdRef.current = null

      if (deletedChatId === currentChatThreadId) {
        navigate('/chats/new')
      }
    },
  })

  const deleteAllChatsMutation = useMutation({
    mutationFn: async () => {
      await deleteAllChatThreads()
    },
    onSuccess: async () => {
      trackEvent('chat_clear_all')
      deleteAllChatsDialogRef.current?.close()
      await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
      navigate('/chats/new')
    },
  })

  const createNewChat = async (closeAfter: boolean = true) => {
    trackEvent('chat_new_clicked')
    navigate(`/chats/new`)
    if (closeAfter && isMobile) {
      setOpenMobile(false)
    }
  }

  const handleChatClick = (threadId: string) => {
    navigate(`/chats/${threadId}`)
    trackEvent('chat_select', { chat_id: threadId })
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const handleSettingsNavigation = (path: string) => {
    navigate(path)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const showSettingsMenu = () => {
    if (!isSettingsRoute) {
      navigate('/settings/preferences')
    }
  }

  const goToMainMenu = async () => {
    // Only wait if query is pending and we have no fallback
    if (isPending && !lastChatPathRef.current) {
      return
    }

    if (lastChatPathRef.current) {
      navigate(lastChatPathRef.current)
    } else if (data && data.length > 0) {
      navigate(`/chats/${data[0].id}`)
    } else {
      await createNewChat(false)
    }
  }

  const handleSearchClick = (e?: React.MouseEvent) => {
    e?.preventDefault()
    e?.stopPropagation()

    if (isCollapsed) {
      toggleSidebar()
      setShowSearch(true)
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    } else if (!showSearch) {
      setShowSearch(true)
    } else {
      setShowSearch(false)
    }
  }

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
