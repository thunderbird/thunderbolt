/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Folder, LayoutGrid, MessageCirclePlus, Plus } from 'lucide-react'
import { useRef } from 'react'
import { useNavigate } from 'react-router'
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
import { ProjectIcon } from '@/projects/project-icon'
import { useProjectArtifactsDialog } from '@/projects/use-project-artifacts-dialog'
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
}: Pick<ChatListProps, 'chatThreads' | 'currentChatThreadId' | 'onChatClick'> & {
  projects: Project[]
  activeId: string | null
  onNewProject: () => void
}) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const artifacts = useProjectArtifactsDialog()
  const preview = useSidebarPreviewState(projects, activeId)
  const openingEditor = useRef(false)

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
              if (openingEditor.current) {
                event.preventDefault()
                openingEditor.current = false
              }
            }}
          >
            <DropdownMenuLabel className="text-muted-foreground">
              <Trans>Projects</Trans>
            </DropdownMenuLabel>
            {preview.items.map((project) => (
              <DropdownMenuSub key={project.id}>
                <DropdownMenuSubTrigger className="gap-2">
                  <ProjectIcon icon={project.icon} className="size-4 shrink-0 [&>img]:size-full" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="flex w-72 max-h-(--radix-dropdown-menu-content-available-height) flex-col gap-0.5 overflow-y-auto">
                    <ChatMenuItems
                      chatThreads={chatThreads.filter((thread) => thread.projectId === project.id)}
                      currentChatThreadId={currentChatThreadId}
                      onChatClick={onChatClick}
                    />
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => navigate(`/chats/new?${new URLSearchParams({ projectId: project.id })}`)}
                    >
                      <MessageCirclePlus />
                      <Trans>New chat</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => artifacts.open(project.id)}>
                      <LayoutGrid />
                      <Trans>Artifacts</Trans>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ))}
            {projects.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                <Trans>Create a project to organize your chats.</Trans>
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
                openingEditor.current = true
                onNewProject()
              }}
            >
              <Plus />
              <Trans>New project</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
