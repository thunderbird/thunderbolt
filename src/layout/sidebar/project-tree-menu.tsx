/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Folder, Plus, Trash2 } from 'lucide-react'
import { useRef, useState, useTransition } from 'react'
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
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useDatabase } from '@/contexts'
import { setProjectPinned } from '@/dal/projects'
import { ProjectActionMenuItems } from '@/projects/project-action-menu-items'
import { ProjectEditorDialog } from '@/projects/project-editor-dialog'
import { ProjectDeleteDialog } from '@/projects/project-delete-dialog'
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
  onDeleteAllProjects,
}: Pick<ChatListProps, 'chatThreads' | 'currentChatThreadId' | 'onChatClick'> & {
  projects: Project[]
  activeId: string | null
  onNewProject: () => void
  onDeleteAllProjects: () => void
}) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const createNewChat = useCreateNewChat()
  const artifacts = useProjectArtifactsDialog()
  const preview = useSidebarPreviewState(projects, activeId)
  const openingEditor = useRef(false)
  const db = useDatabase()
  const [, startTransition] = useTransition()
  const [management, setManagement] = useState<{ project: Project; action: 'edit' | 'delete' } | null>(null)
  const openManagement = (project: Project, action: 'edit' | 'delete') => {
    openingEditor.current = true
    setManagement({ project, action })
  }

  return (
    <>
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
                    <ProjectIcon icon={project.icon} className="size-4 shrink-0" />
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
                      <ProjectActionMenuItems
                        pinned={project.pinnedOrder !== null}
                        onNewChat={() => createNewChat(project.id)}
                        onOpenArtifacts={() => artifacts.open(project.id)}
                        onTogglePin={() =>
                          startTransition(async () => {
                            await setProjectPinned(db, project.id, project.pinnedOrder === null ? 0 : null)
                          })
                        }
                        onEdit={() => openManagement(project, 'edit')}
                        onDelete={() => openManagement(project, 'delete')}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              ))}
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
                  openingEditor.current = true
                  onNewProject()
                }}
              >
                <Plus />
                <Trans>New project</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={projects.length === 0}
                onSelect={() => {
                  openingEditor.current = true
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
      {management?.action === 'edit' && (
        <ProjectEditorDialog project={management.project} onClose={() => setManagement(null)} />
      )}
      {management?.action === 'delete' && (
        <ProjectDeleteDialog
          projectId={management.project.id}
          onClose={() => setManagement(null)}
          onDeleted={() => {
            if (activeId === management.project.id) {
              navigate('/chats/new')
            }
          }}
        />
      )}
    </>
  )
}
