/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import { SidebarFooter } from '@/components/sidebar-footer'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import type { DeleteAllChatsMutationType, DeleteChatMutationType } from '@/layout/sidebar/types'
import { cn } from '@/lib/utils'
import { CheckSquare, MessageCirclePlus } from 'lucide-react'
import { type MouseEvent, type RefObject, useState } from 'react'
import { useLocation } from 'react-router'
import { ChatList } from './chat-list'
import { SidebarNavToggle } from './nav-toggle'
import { RailDivider } from './rail-divider'
import { SidebarHeader } from './sidebar-header'
import type { ChatThread, SidebarSection } from './types'

type ChatSidebarContentProps = {
  isMobile: boolean
  isCollapsed: boolean
  chatThreads: ChatThread[]
  currentChatThreadId?: string
  searchQuery: string
  debouncedSearchQuery: string
  showSearch: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteChatMutation: DeleteChatMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  deleteChatDialogRef: RefObject<DeleteChatDialogRef | null>
  threadIdRef: RefObject<string | null>
  showTasks: boolean
  activeSection: SidebarSection
  onSectionChange: (section: SidebarSection) => void
  onCreateNewChat: () => void
  onTasksClick: () => void
  onChatClick: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onSearchClick: (e?: MouseEvent) => void
  onSearchQueryChange: (value: string) => void
}

type TasksMenuItemProps = {
  isActive: boolean
  onClick: () => void
}

const TasksMenuItem = ({ isActive, onClick }: TasksMenuItemProps) => (
  <SidebarMenuItem>
    <SidebarMenuButton onClick={onClick} tooltip="Tasks" className="cursor-pointer" isActive={isActive}>
      <CheckSquare className="size-[var(--icon-size-default)]" />
      <span>Tasks</span>
    </SidebarMenuButton>
  </SidebarMenuItem>
)

export const ChatSidebarContent = ({
  isMobile,
  isCollapsed,
  chatThreads,
  currentChatThreadId,
  searchQuery,
  debouncedSearchQuery,
  showSearch,
  searchInputRef,
  deleteAllChatsMutation,
  deleteChatMutation,
  deleteAllChatsDialogRef,
  deleteChatDialogRef,
  threadIdRef,
  showTasks,
  activeSection,
  onSectionChange,
  onCreateNewChat,
  onTasksClick,
  onChatClick,
  onRename,
  onSearchClick,
  onSearchQueryChange,
}: ChatSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()
  const [hasContentBelow, setHasContentBelow] = useState(false)

  return (
    <SidebarContent className="flex flex-col h-full gap-0 overflow-hidden md:gap-2">
      <SidebarHeader
        onToggle={toggleSidebar}
        navToggle={<SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} />}
      />

      {!isMobile && (
        <SidebarGroup className={cn('flex-shrink-0', isCollapsed && 'pt-2 pb-0')}>
          {/* Collapsed: pb-0 so SidebarContent's gap-2 alone spaces the divider
              below; pt-2 gives the nav toggle the same 8px above as the rail's
              p-2 leaves on its sides. */}
          <SidebarGroupContent className="flex flex-col gap-2">
            {isCollapsed && (
              <SidebarNavToggle vertical activeSection={activeSection} onSectionChange={onSectionChange} />
            )}
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={onCreateNewChat}
                  tooltip="New Chat"
                  className="cursor-pointer"
                  isActive={location.pathname === '/chats/new'}
                >
                  <MessageCirclePlus className="size-[var(--icon-size-default)]" />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {showTasks && <TasksMenuItem isActive={location.pathname.startsWith('/tasks')} onClick={onTasksClick} />}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
      {isCollapsed && chatThreads.length > 0 && <RailDivider />}

      <ChatList
        chatThreads={chatThreads}
        currentChatThreadId={currentChatThreadId}
        isCollapsed={isCollapsed}
        isMobile={isMobile}
        debouncedSearchQuery={debouncedSearchQuery}
        deleteAllChatsMutation={deleteAllChatsMutation}
        deleteChatMutation={deleteChatMutation}
        deleteAllChatsDialogRef={deleteAllChatsDialogRef}
        deleteChatDialogRef={deleteChatDialogRef}
        threadIdRef={threadIdRef}
        searchQuery={searchQuery}
        showSearch={showSearch}
        searchInputRef={searchInputRef}
        mobileNavToggle={<SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} />}
        mobileSecondaryNavigation={
          showTasks ? (
            <SidebarMenu className="mt-2 flex-shrink-0">
              <TasksMenuItem isActive={location.pathname.startsWith('/tasks')} onClick={onTasksClick} />
            </SidebarMenu>
          ) : null
        }
        onChatClick={onChatClick}
        onRename={onRename}
        onSearchClick={onSearchClick}
        onSearchQueryChange={onSearchQueryChange}
        onContentBelowChange={setHasContentBelow}
      />

      <SidebarFooter className="flex-shrink-0 md:-mt-2" hasContentBelow={hasContentBelow} />
    </SidebarContent>
  )
}
