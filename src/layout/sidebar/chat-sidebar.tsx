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
import { CheckSquare, FolderOpen, MessageCirclePlus } from 'lucide-react'
import { type RefObject } from 'react'
import { useLocation } from 'react-router'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { MessageCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useDatabase } from '@/contexts'
import { useChatStore } from '@/chats/chat-store'
import { setChatThreadProject } from '@/dal/projects'
import { resolveChatDrop, type ChatDragData } from '@/projects/chat-drop'
import { ProjectDropList } from './project-drop-list'
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
  onProjectsClick: () => void
  onChatClick: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onSearchClick: () => void
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

const ProjectsMenuItem = ({ isActive, onClick }: TasksMenuItemProps) => (
  <SidebarMenuItem>
    <SidebarMenuButton onClick={onClick} tooltip="Projects" className="cursor-pointer" isActive={isActive}>
      <FolderOpen className="size-[var(--icon-size-default)]" />
      <span>Projects</span>
    </SidebarMenuButton>
  </SidebarMenuItem>
)

export const ChatSidebarContent = ({
  isMobile,
  isCollapsed,
  chatThreads,
  currentChatThreadId,
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
  onProjectsClick,
  onChatClick,
  onRename,
  onSearchClick,
}: ChatSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()
  const db = useDatabase()
  const queryClient = useQueryClient()
  // The dragged chat, or null when nothing is in flight. Holds the whole payload
  // (not just a boolean) so the drop rows can hide the unassign target for a chat
  // that has no project, and the overlay can show the chat's title.
  const [draggingChat, setDraggingChat] = useState<ChatDragData | null>(null)

  // 8px before a drag starts, so a chat row's click, context menu, and mobile
  // long-press all still fire (same constraint the tasks list uses).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragStart = ({ active }: DragStartEvent) => {
    setDraggingChat((active.data.current as ChatDragData | undefined) ?? { title: null, projectId: null })
  }

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setDraggingChat(null)
    const drop = resolveChatDrop(active.id, over?.id ?? null)
    if (!drop) {
      return
    }
    await setChatThreadProject(db, drop.chatThreadId, drop.projectId)
    // The row is the source of truth for the next send, but the header badge
    // reads the live session — without this a chat only shows its new project
    // after a reload. Guarded because a session exists only for a chat that has
    // been opened this run, and `updateSession` throws on an unknown id.
    const store = useChatStore.getState()
    if (store.sessions.has(drop.chatThreadId)) {
      store.updateSession(drop.chatThreadId, { projectId: drop.projectId })
    }
    // Only the chat rows need a nudge; the project counts are a reactive
    // PowerSync query and update themselves.
    await queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragCancel={() => setDraggingChat(null)}
      onDragEnd={handleDragEnd}
    >
      <SidebarContent className="relative flex h-full flex-col gap-0 overflow-hidden md:gap-2">
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
                <ProjectsMenuItem isActive={location.pathname.startsWith('/projects')} onClick={onProjectsClick} />
                {showTasks && (
                  <TasksMenuItem isActive={location.pathname.startsWith('/tasks')} onClick={onTasksClick} />
                )}
              </SidebarMenu>
              {/* Drop targets for dragging a chat into a project. */}
              <ProjectDropList
                isDragging={draggingChat !== null}
                draggingFromProjectId={draggingChat?.projectId ?? null}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {isCollapsed && chatThreads.length > 0 && <RailDivider />}

        <ChatList
          chatThreads={chatThreads}
          currentChatThreadId={currentChatThreadId}
          isCollapsed={isCollapsed}
          isMobile={isMobile}
          deleteAllChatsMutation={deleteAllChatsMutation}
          deleteChatMutation={deleteChatMutation}
          deleteAllChatsDialogRef={deleteAllChatsDialogRef}
          deleteChatDialogRef={deleteChatDialogRef}
          threadIdRef={threadIdRef}
          mobileNavToggle={<SidebarNavToggle activeSection={activeSection} onSectionChange={onSectionChange} />}
          mobileSecondaryNavigation={
            <SidebarMenu className="mt-2 flex-shrink-0">
              <ProjectsMenuItem isActive={location.pathname.startsWith('/projects')} onClick={onProjectsClick} />
              {showTasks && <TasksMenuItem isActive={location.pathname.startsWith('/tasks')} onClick={onTasksClick} />}
            </SidebarMenu>
          }
          onChatClick={onChatClick}
          onRename={onRename}
          onSearchClick={onSearchClick}
        />

        <SidebarFooter className="flex-shrink-0 max-md:absolute max-md:inset-x-0 max-md:bottom-0 md:-mt-2" />
      </SidebarContent>
      {/* A chip rather than a clone of the row: the chat list is virtualized, so
          the original node can unmount mid-drag and a cloned row would vanish. */}
      <DragOverlay dropAnimation={null}>
        {draggingChat && (
          <div className="pointer-events-none flex max-w-[15rem] items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
            <MessageCircle className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-[length:var(--font-size-sm)]">{draggingChat.title ?? 'Untitled chat'}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
