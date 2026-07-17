/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { Sidebar as SidebarRoot, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useDatabase } from '@/contexts'
import { deleteAllChatThreads, deleteChatThread, getAllChatThreads, updateChatThread } from '@/dal'
import { useDebounce } from '@/hooks/use-debounce'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { ChatSidebarContent } from './chat-sidebar'
import { SettingsSidebarContent } from './settings-sidebar'
import type { SidebarSection } from './types'
import { toCompilableQuery } from '@powersync/drizzle-driver'

/**
 * Main sidebar component that orchestrates between chat and settings sidebars
 */
export default function Sidebar() {
  const db = useDatabase()
  const navigate = useNavigate()
  const location = useLocation()
  const { setOpenMobile, state, toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()
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
  const [sectionOverride, setSectionOverride] = useState<{ section: SidebarSection; pathname: string } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: false,
  })

  useEffect(() => {
    if (showSearch && searchInputRef.current && !isCollapsed) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    }
  }, [showSearch, isCollapsed])

  const { data } = useQuery({
    queryKey: ['chatThreads'],
    query: toCompilableQuery(getAllChatThreads(db)),
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
      await deleteChatThread(db, id)
    },
    onSuccess: async () => {
      const deletedChatId = threadIdRef.current
      trackEvent('chat_delete', { chat_id: deletedChatId })
      deleteChatDialogRef.current?.close()
      threadIdRef.current = null

      if (deletedChatId === currentChatThreadId) {
        navigate('/chats/new')
      }
    },
  })

  const renameChatMutation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      await updateChatThread(db, id, { title })
    },
  })

  const renameMutate = renameChatMutation.mutate
  const handleRename = useCallback(
    (threadId: string, title: string) => {
      renameMutate({ id: threadId, title })
    },
    [renameMutate],
  )

  const deleteAllChatsMutation = useMutation({
    mutationFn: async () => {
      await deleteAllChatThreads(db)
    },
    onSuccess: async () => {
      trackEvent('chat_clear_all')
      deleteAllChatsDialogRef.current?.close()
      navigate('/chats/new')
    },
  })

  const createNewChat = () => {
    trackEvent('chat_new_clicked')
    navigate(`/chats/new`)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const handleChatClick = useCallback(
    (threadId: string) => {
      navigate(`/chats/${threadId}`)
      trackEvent('chat_select', { chat_id: threadId })
      if (isMobile) {
        setOpenMobile(false)
      }
    },
    [navigate, isMobile, setOpenMobile],
  )

  const handleNavigate = (path: string) => {
    navigate(path)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  const routeSection: SidebarSection = isSettingsRoute ? 'settings' : 'chats'

  // Toggling sections swaps the sidebar without navigating; the override is
  // keyed to the pathname it was set on, so any navigation invalidates it and
  // the section falls back to being derived from the route.
  const activeSection = sectionOverride?.pathname === location.pathname ? sectionOverride.section : routeSection

  // Toggling between Chats and Settings only swaps the sidebar content — the
  // current page stays until the user picks an entry from the new sidebar.
  const handleSectionChange = (section: SidebarSection) => {
    setSectionOverride(section === routeSection ? null : { section, pathname: location.pathname })
  }

  const handleSearchClick = (e?: MouseEvent) => {
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
        {activeSection === 'settings' ? (
          <SettingsSidebarContent
            isCollapsed={isCollapsed}
            onSectionChange={handleSectionChange}
            onSettingsNavigate={handleNavigate}
          />
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
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
            onCreateNewChat={createNewChat}
            onTasksClick={() => handleNavigate('/tasks')}
            onRename={handleRename}
            onChatClick={handleChatClick}
            onSearchClick={handleSearchClick}
            onSearchQueryChange={setSearchQuery}
          />
        )}
      </TooltipProvider>
    </SidebarRoot>
  )
}
