/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { Sidebar as SidebarRoot, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useDatabase } from '@/contexts'
import { deleteChatThread, getAllChatThreads, updateChatThread } from '@/dal'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useDeleteAllChats } from '@/hooks/use-delete-all-chats'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { useSearchPalette } from '@/search/search-palette-context'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { ChatSidebarContent } from './chat-sidebar'
import { SettingsSidebarContent } from './settings-sidebar'
import { useSidebarSection } from './use-sidebar-section'
import { toCompilableQuery } from '@powersync/drizzle-driver'

/**
 * Main sidebar component that orchestrates between chat and settings sidebars
 */
export default function Sidebar() {
  const db = useDatabase()
  const navigate = useNavigate()
  const location = useLocation()
  const { closeMobileSidebar, state } = useSidebar()
  const { isMobile } = useIsMobile()
  const { open: openSearchPalette } = useSearchPalette()
  const deleteAllChatsDialogRef = useRef<DeleteAllChatsDialogRef>(null)
  const deleteChatDialogRef = useRef<DeleteChatDialogRef>(null)
  const threadIdRef = useRef<string | null>(null)

  const { chatThreadId: currentChatThreadId } = useParams()

  // Only use collapsed icon view on desktop, not mobile
  const isCollapsed = !isMobile && state === 'collapsed'

  const { activeSection, setActiveSection } = useSidebarSection(location.pathname)

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: false,
  })

  const { data } = useQuery({
    queryKey: ['chatThreads'],
    query: toCompilableQuery(getAllChatThreads(db)),
    placeholderData: (previousData) => previousData,
  })

  const chatThreads = useMemo(() => data ?? [], [data])

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

  const deleteAllChats = useDeleteAllChats()
  const deleteAllChatsMutation = useMutation({
    mutationFn: deleteAllChats,
    onSuccess: () => {
      deleteAllChatsDialogRef.current?.close()
    },
  })

  // Keep the current chat mounted until the mobile sidebar has fully covered
  // it. Hydrating and mounting a long destination chat during the 300ms close
  // animation competes for the main thread and makes the gesture visibly jank.
  // Desktop navigation remains synchronous.
  const navigateAndCloseSidebar = useCallback(
    async (path: string) => {
      if (isMobile) {
        await closeMobileSidebar()
      }
      navigate(path)
    },
    [closeMobileSidebar, isMobile, navigate],
  )

  const startNewChat = useCreateNewChat()
  const createNewChat = async () => {
    if (isMobile) {
      await closeMobileSidebar()
    }
    startNewChat()
  }

  const handleChatClick = useCallback(
    (threadId: string) => {
      trackEvent('chat_select', { chat_id: threadId })
      void navigateAndCloseSidebar(`/chats/${threadId}`)
    },
    [navigateAndCloseSidebar],
  )

  const handleNavigate = (path: string) => {
    void navigateAndCloseSidebar(path)
  }

  return (
    <SidebarRoot collapsible={isMobile ? 'offcanvas' : 'icon'}>
      <TooltipProvider>
        {activeSection === 'settings' ? (
          <SettingsSidebarContent
            isCollapsed={isCollapsed}
            onSectionChange={setActiveSection}
            onSettingsNavigate={handleNavigate}
          />
        ) : (
          <ChatSidebarContent
            isMobile={isMobile}
            isCollapsed={isCollapsed}
            chatThreads={chatThreads}
            currentChatThreadId={currentChatThreadId}
            deleteAllChatsMutation={deleteAllChatsMutation}
            deleteChatMutation={deleteChatMutation}
            deleteAllChatsDialogRef={deleteAllChatsDialogRef}
            deleteChatDialogRef={deleteChatDialogRef}
            threadIdRef={threadIdRef}
            showTasks={experimentalFeatureTasks.value}
            activeSection={activeSection}
            onSectionChange={setActiveSection}
            onCreateNewChat={createNewChat}
            onTasksClick={() => handleNavigate('/tasks')}
            onRename={handleRename}
            onChatClick={handleChatClick}
            onSearchClick={openSearchPalette}
          />
        )}
      </TooltipProvider>
    </SidebarRoot>
  )
}
