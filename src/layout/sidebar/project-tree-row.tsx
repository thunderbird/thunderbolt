/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDroppable } from '@dnd-kit/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { projectDropId } from '@/projects/chat-drop'
import type { ProjectActionHandlers } from '@/projects/project-action-menu-items'
import { ProjectActions } from '@/projects/project-actions'
import { ProjectIcon } from '@/projects/project-icon'
import { ProjectSshStatus } from '@/projects/project-ssh-status'
import type { Project } from '@/types'
import { ChatListItem } from './chat-list-item'
import { useSidebarPreviewState } from './use-sidebar-preview-state'
import { SidebarListToggle } from './sidebar-list-toggle'
import type { ChatListProps, ChatThread } from './types'

const projectRowActionClass =
  'bg-transparent hover:bg-transparent dark:hover:bg-transparent active:bg-transparent data-[state=open]:bg-transparent'

type ProjectTreeRowProps = Pick<
  ChatListProps,
  | 'currentChatThreadId'
  | 'isMobile'
  | 'deleteChatMutation'
  | 'deleteChatDialogRef'
  | 'threadIdRef'
  | 'onChatClick'
  | 'onRename'
  | 'onMoveToProject'
> & {
  project: Project
  chats: ChatThread[]
  expanded: boolean
  active: boolean
  draggingFromProjectId: string | null
  actions: ProjectActionHandlers
  onToggle: () => void
}

export const ProjectTreeRow = ({ project, chats, expanded, active, onToggle, ...props }: ProjectTreeRowProps) => {
  const { t } = useLingui()
  const chatList = useSidebarPreviewState(chats, props.currentChatThreadId)
  const { setNodeRef, isOver } = useDroppable({
    id: projectDropId(project.id),
    disabled: props.draggingFromProjectId === project.id,
  })

  return (
    <SidebarMenuItem>
      <ProjectActions project={project} actions={props.actions} triggerClassName={projectRowActionClass}>
        {(menu) => (
          <div
            ref={setNodeRef}
            className={cn('group/project relative rounded-xl', isOver && 'bg-accent ring-2 ring-ring')}
          >
            <SidebarMenuButton
              tooltip={project.name}
              isActive={active}
              aria-expanded={expanded}
              aria-controls={`project-chats-${project.id}`}
              onClick={onToggle}
              className="min-w-0 cursor-pointer gap-2 md:pr-9 group-hover/project:bg-sidebar-accent group-hover/project:text-sidebar-accent-foreground group-data-[state=open]/project:bg-sidebar-accent group-data-[state=open]/project:text-sidebar-accent-foreground group-has-data-[state=open]/project:bg-sidebar-accent group-has-data-[state=open]/project:text-sidebar-accent-foreground"
            >
              <ProjectIcon icon={project.icon} className="size-[var(--icon-size-default)] shrink-0" />
              <span className="truncate">{project.name}</span>
              <ProjectSshStatus projectId={project.id} />
            </SidebarMenuButton>
            {menu && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2 transition-opacity md:opacity-0 md:group-hover/project:opacity-100 md:group-focus-within/project:opacity-100 md:group-data-[state=open]/project:opacity-100 md:group-has-data-[state=open]/project:opacity-100">
                {menu}
              </div>
            )}
          </div>
        )}
      </ProjectActions>
      {expanded && (
        <div id={`project-chats-${project.id}`} className="ml-4 mt-1 border-l border-border/70 pl-2">
          <SidebarMenu>
            {chatList.items.map((thread) => (
              <SidebarMenuItem key={thread.id}>
                <ChatListItem
                  thread={thread}
                  isActive={thread.id === props.currentChatThreadId}
                  isMobile={props.isMobile}
                  deleteChatMutation={props.deleteChatMutation}
                  deleteChatDialogRef={props.deleteChatDialogRef}
                  threadIdRef={props.threadIdRef}
                  onChatClick={props.onChatClick}
                  onRename={props.onRename}
                  onMoveToProject={props.onMoveToProject}
                />
              </SidebarMenuItem>
            ))}
            {chatList.hasOverflow && (
              <SidebarMenuItem>
                <SidebarListToggle
                  onToggle={chatList.toggle}
                  showAll={chatList.showAll}
                  controls={`project-chats-${project.id}`}
                  label={
                    chatList.showAll ? t`Show fewer chats in ${project.name}` : t`Show more chats in ${project.name}`
                  }
                />
              </SidebarMenuItem>
            )}
            {chats.length === 0 && (
              <li className="px-2 py-2 text-xs text-muted-foreground">
                <Trans>No chats yet.</Trans>
              </li>
            )}
          </SidebarMenu>
        </div>
      )}
    </SidebarMenuItem>
  )
}
