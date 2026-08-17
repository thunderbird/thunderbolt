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
  MeasuringStrategy,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { resolveChatDrop, type ChatDragData } from '@/projects/chat-drop'
import { MoveChatToProjectDialog } from '@/projects/move-chat-to-project-dialog'
import { useMoveChatToProject } from '@/projects/use-move-chat-to-project'
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
  const moveChatToProject = useMoveChatToProject()
  // The chat whose project is being picked from a row's action menu. One dialog
  // for the whole list — a per-row instance would mount hundreds of them, and the
  // rows are virtualized anyway.
  const [moveTarget, setMoveTarget] = useState<{ chatThreadId: string; projectId: string | null } | null>(null)
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

  /**
   * dnd-kit ignores the promise this returns, so a rejected write would leave the
   * chat where it was with nothing said about it. There is no notification surface
   * in the sidebar, so the failure is logged with its target — the same treatment
   * `chat-instance.ts` gives its own fire-and-forget writes.
   */
  /** Shared by the drop and the menu: failures are logged because the sidebar has
   *  no notification surface. */
  const runMove = async (chatThreadId: string, projectId: string | null) => {
    try {
      await moveChatToProject({ chatThreadId, projectId })
    } catch (error) {
      console.error('Moving a chat into a project failed', { chatThreadId, projectId, error })
    }
  }

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setDraggingChat(null)
    const drop = resolveChatDrop(active.id, over?.id ?? null)
    if (!drop) {
      return
    }
    await runMove(drop.chatThreadId, drop.projectId)
  }

  return (
    <DndContext
      // Re-measure droppables continuously instead of once per drag. The drop
      // zone changes height the moment a drag starts — the "Move to project"
      // label appears and the row cap lifts — so a single measurement taken at
      // drag start describes a layout that no longer exists, and every rect below
      // the label is offset by its height.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
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
                <ProjectsMenuItem isActive={location.pathname === '/projects'} onClick={onProjectsClick} />
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
              <ProjectsMenuItem isActive={location.pathname === '/projects'} onClick={onProjectsClick} />
              {showTasks && <TasksMenuItem isActive={location.pathname.startsWith('/tasks')} onClick={onTasksClick} />}
            </SidebarMenu>
          }
          onChatClick={onChatClick}
          onRename={onRename}
          onMoveToProject={(chatThreadId, projectId) => setMoveTarget({ chatThreadId, projectId })}
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

      {moveTarget && (
        <MoveChatToProjectDialog
          open
          currentProjectId={moveTarget.projectId}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          onSelect={(projectId) => {
            const { chatThreadId } = moveTarget
            setMoveTarget(null)
            void runMove(chatThreadId, projectId)
          }}
        />
      )}
    </DndContext>
  )
}
