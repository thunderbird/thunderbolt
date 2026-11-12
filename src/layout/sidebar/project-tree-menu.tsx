/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Folder, Plus, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { ProjectActionMenuItems, type ProjectActionHandlers } from '@/projects/project-action-menu-items'
import { ProjectIcon } from '@/projects/project-icon'
import { ProjectSshStatus } from '@/projects/project-ssh-status'
import type { Project } from '@/types'
import { ChatMenuItems } from './chat-menu-items'
import type { ChatListProps } from './types'
import { useSidebarPreviewState } from './use-sidebar-preview-state'

/** One rail entry with project submenus, keeping the sidebar collapsed while navigating. */
export const ProjectTreeMenu = ({
  projects,
  activeId,
  chatThreads,
  currentChatThreadId,
  onChatClick,
  onNewProject,
  onDeleteAllProjects,
  getProjectActions,
}: Pick<ChatListProps, 'chatThreads' | 'currentChatThreadId' | 'onChatClick'> & {
  projects: Project[]
  activeId: string | null
  getProjectActions: (project: Project) => ProjectActionHandlers
  onNewProject: () => void
  onDeleteAllProjects: () => void
}) => {
  const { t } = useLingui()
  const preview = useSidebarPreviewState(projects, activeId)
  const openingDialog = useRef(false)
  const handOffFocus = (action: () => void) => () => {
    openingDialog.current = true
    action()
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip={t`Projects`} aria-label={t`Projects`} isActive={activeId !== null}>
              <Folder />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-64"
            onCloseAutoFocus={(event) => {
              if (openingDialog.current) {
                event.preventDefault()
                openingDialog.current = false
              }
            }}
          >
            <DropdownMenuLabel className="text-muted-foreground">
              <Trans>Projects</Trans>
            </DropdownMenuLabel>
            {preview.items.map((project) => {
              const actions = getProjectActions(project)
              return (
                <DropdownMenuSub key={project.id}>
                  <DropdownMenuSubTrigger className="gap-2">
                    <ProjectIcon icon={project.icon} className="size-4 shrink-0" />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="min-w-0 truncate">{project.name}</span>
                      <ProjectSshStatus projectId={project.id} />
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent className="flex w-72 max-h-(--radix-dropdown-menu-content-available-height) flex-col gap-0.5 overflow-y-auto">
                      <ChatMenuItems
                        chatThreads={chatThreads.filter((thread) => thread.projectId === project.id)}
                        currentChatThreadId={currentChatThreadId}
                        onChatClick={onChatClick}
                      />
                      <DropdownMenuSeparator />
                      <ProjectActionMenuItems
                        pinned={project.pinnedOrder !== null}
                        {...actions}
                        onNewChat={handOffFocus(actions.onNewChat)}
                        onEdit={handOffFocus(actions.onEdit)}
                        onDelete={handOffFocus(actions.onDelete)}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              )
            })}
            {projects.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                <Trans>Organize chats with projects.</Trans>
              </p>
            )}
            {preview.hasOverflow && (
              <DropdownMenuItem
                className="text-muted-foreground"
                onSelect={(event) => {
                  event.preventDefault()
                  preview.toggle()
                }}
              >
                {preview.showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                openingDialog.current = true
                onNewProject()
              }}
            >
              <Plus />
              <Trans>New project</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={projects.length === 0}
              onSelect={() => {
                openingDialog.current = true
                onDeleteAllProjects()
              }}
            >
              <Trash2 />
              <Trans>Delete all projects</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
