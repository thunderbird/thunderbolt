/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { FolderMinus, Plus } from 'lucide-react'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { unassignDropId } from '@/projects/chat-drop'
import { ProjectEditorDialog } from '@/projects/project-editor-dialog'
import { ProjectDropRow } from './project-drop-row'
import { ProjectTreeRow, type ProjectTreeProps } from './project-tree-row'
import { useProjectTreeState } from './use-project-tree-state'
import { SidebarListToggle } from './sidebar-list-toggle'
import { SidebarSectionToggle } from './sidebar-section-toggle'
import { ProjectTreeMenu } from './project-tree-menu'

/** Projects and their chats live entirely in the sidebar. */
export const ProjectTree = (props: ProjectTreeProps) => {
  const { t } = useLingui()
  const {
    projects,
    activeId,
    state,
    projectList,
    editorOpen,
    sectionExpanded,
    openEditor,
    closeEditor,
    toggleSection,
    toggleProject,
    projectCreated,
  } = useProjectTreeState(props.chatThreads, props.currentChatThreadId)

  if (props.isCollapsed) {
    return (
      <>
        <ProjectTreeMenu
          projects={projects}
          activeId={activeId}
          chatThreads={props.chatThreads}
          currentChatThreadId={props.currentChatThreadId}
          onChatClick={props.onChatClick}
          onNewProject={openEditor}
        />
        {editorOpen && <ProjectEditorDialog onClose={closeEditor} onCreated={projectCreated} />}
      </>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between max-md:mb-2">
        <SidebarSectionToggle expanded={sectionExpanded} onToggle={toggleSection} controls="sidebar-projects-section">
          <Trans>Projects</Trans>
        </SidebarSectionToggle>
        <Button
          variant="ghost"
          size="icon"
          className={cn(mutedIconButtonClass, mobileHeaderControlFillClass)}
          aria-label={t`New project`}
          onClick={openEditor}
        >
          <Plus className="size-4" />
        </Button>
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
            <Trans>Create a project to organize your chats.</Trans>
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
      {editorOpen && <ProjectEditorDialog onClose={closeEditor} onCreated={projectCreated} />}
    </div>
  )
}
