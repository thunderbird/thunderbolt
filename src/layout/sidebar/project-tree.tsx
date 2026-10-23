/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { FolderMinus, Plus, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'
import { unassignDropId } from '@/projects/chat-drop'
import { ProjectCreateDialog } from '@/projects/project-create-dialog'
import { ProjectDeleteDialog } from '@/projects/project-delete-dialog'
import { ProjectDropRow } from './project-drop-row'
import { ProjectTreeRow, type ProjectTreeProps } from './project-tree-row'
import { useProjectTreeState } from './use-project-tree-state'
import { SidebarListToggle } from './sidebar-list-toggle'
import { SidebarSectionToggle } from './sidebar-section-toggle'
import { ProjectTreeMenu } from './project-tree-menu'

/** Projects and their chats live entirely in the sidebar. */
export const ProjectTree = (props: ProjectTreeProps) => {
  const { t } = useLingui()
  const createTriggerRef = useRef<HTMLDivElement>(null)
  const {
    projects,
    activeId,
    state,
    projectList,
    dialog,
    sectionExpanded,
    openCreateDialog,
    openDeleteAll,
    closeDialog,
    projectsDeleted,
    toggleSection,
    toggleProject,
    projectCreated,
  } = useProjectTreeState(props.chatThreads, props.currentChatThreadId)

  return (
    <>
      {props.isCollapsed ? (
        <div ref={createTriggerRef}>
          <ProjectTreeMenu
            projects={projects}
            activeId={activeId}
            chatThreads={props.chatThreads}
            currentChatThreadId={props.currentChatThreadId}
            onChatClick={props.onChatClick}
            onNewProject={openCreateDialog}
            onDeleteAllProjects={openDeleteAll}
          />
        </div>
      ) : (
        <div className="mt-3">
          <div ref={createTriggerRef} className="flex items-center">
            <SidebarSectionToggle
              expanded={sectionExpanded}
              onToggle={toggleSection}
              controls="sidebar-projects-section"
              label={t`Projects`}
              actions={[
                { label: t`New project`, icon: <Plus className="size-4" />, onSelect: openCreateDialog },
                {
                  label: t`Delete all projects`,
                  icon: <Trash2 className="size-4" />,
                  disabled: projects.length === 0,
                  onSelect: openDeleteAll,
                },
              ]}
            />
          </div>
          {/* Reserve space for the drop/focus rings without shifting the rows. */}
          <div id="sidebar-projects-section" hidden={!sectionExpanded} className="-m-1 p-1">
            <SidebarMenu id="sidebar-projects">
              {projectList.items.map((project) => (
                <ProjectTreeRow
                  key={project.id}
                  {...props}
                  project={project}
                  chats={props.chatThreads.filter((thread) => thread.projectId === project.id)}
                  active={project.id === activeId}
                  expanded={state.expanded.has(project.id)}
                  onToggle={() => toggleProject(project.id)}
                />
              ))}
              {projectList.hasOverflow && (
                <SidebarMenuItem>
                  <SidebarListToggle
                    className="pl-8 max-md:pl-9"
                    showAll={projectList.showAll}
                    onToggle={projectList.toggle}
                    controls="sidebar-projects"
                    label={projectList.showAll ? t`Show fewer projects` : t`Show more projects`}
                  />
                </SidebarMenuItem>
              )}
            </SidebarMenu>
            {projects.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                <Trans>Organize chats with projects.</Trans>
              </p>
            )}
            {props.isDragging && props.draggingFromProjectId !== null && (
              <SidebarMenu>
                <ProjectDropRow
                  dropId={unassignDropId}
                  label={t`Remove from project`}
                  icon={<FolderMinus className="size-4" />}
                />
              </SidebarMenu>
            )}
          </div>
        </div>
      )}
      {dialog === 'create' && (
        <ProjectCreateDialog onClose={closeDialog} onCreated={projectCreated} returnFocusRef={createTriggerRef} />
      )}
      {dialog === 'deleteAll' && (
        <ProjectDeleteDialog projectId={null} onClose={closeDialog} onDeleted={projectsDeleted} />
      )}
    </>
  )
}
