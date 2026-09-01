/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The sidebar's project rows, which double as drop targets: dragging a chat onto
 * one moves it into that project (see `src/projects/chat-drop.ts`).
 *
 * While a drag is in flight the whole group is framed as a drop zone, each row
 * lifts on hover, and a "Remove from project" row appears — but only when the
 * dragged chat actually belongs to a project, since otherwise there is nothing
 * to remove it from. The row cap does NOT lift for a drag — see
 * `visibleProjects` — so the list's height never changes mid-gesture.
 */

import { Trans, useLingui } from '@lingui/react/macro'
import { useDroppable } from '@dnd-kit/core'
import { Ellipsis, FolderMinus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'

import { SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useProjects } from '@/dal/projects'
import { cn } from '@/lib/utils'
import { projectDropId, unassignDropId } from '@/projects/chat-drop'
import { ProjectIcon } from '@/projects/project-icon'
import type { Project } from '@/types'

type DropRowProps = {
  dropId: string
  label: string
  icon: ReturnType<typeof ProjectIcon> | null
  isDragging: boolean
  /** Marks the chat's current project — dropping there is a no-op. */
  isCurrent?: boolean
  /** Whether this project's page is the one open, so the row reads as selected
   *  like every other sidebar item. */
  isActive?: boolean
  onClick?: () => void
}

const DropRow = ({ dropId, label, icon, isDragging, isCurrent, isActive, onClick }: DropRowProps) => {
  const { t } = useLingui()
  const { setNodeRef, isOver } = useDroppable({ id: dropId, disabled: isCurrent })

  return (
    <SidebarMenuItem ref={setNodeRef}>
      <SidebarMenuButton
        onClick={onClick}
        isActive={isActive}
        tooltip={isCurrent ? t`${label} — already in this project` : label}
        className={cn(
          'cursor-pointer transition-all duration-150',
          // A ring, not a fill: the row can also be the active route, and the two
          // states have to stay distinguishable.
          isOver && 'bg-accent ring-2 ring-ring ring-offset-1 ring-offset-sidebar',
          isDragging && isCurrent && 'opacity-40',
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        {isDragging && !isCurrent && (
          <span className="ml-auto text-[length:var(--font-size-xs)] text-muted-foreground">
            {isOver ? t`Drop` : ''}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

type ProjectDropRowsProps = {
  /** The account's live projects. Passed in rather than read from the DAL here, so
   *  the rendering rules below (the cap, the active row) are testable without
   *  module-mocking `@/dal/projects` — a bun `mock.module` is installed
   *  worker-wide and would leak `useProjects` into every sibling test. */
  projects: readonly Project[]
  isDragging: boolean
  /** Project of the chat being dragged, when one is in flight. */
  draggingFromProjectId: string | null
}

/**
 * How many projects the idle sidebar shows before collapsing the rest behind a
 * link to the projects page. Projects sit above the chat list, so an unbounded
 * list would push chats out of view on an account with many of them.
 */
const idleVisibleLimit = 5

/**
 * The rows to render: the first {@link idleVisibleLimit}, plus the open project so
 * the active row can't be the one collapsed away.
 *
 * The cap holds **during a drag too**, which is a reversal. It used to lift, on the
 * reasoning that every project should be reachable as a drop target — but on an
 * account with ~100 projects that expanded the group from 5 rows to 100 in the same
 * render that started the drag. Everything below shifted down by ~95 rows,
 * including the chat row the user had just grabbed, so the pointer was no longer
 * over the thing being dragged and the drop became unaimable (reported by Rai).
 *
 * A 100-row drop zone was never usable anyway. Projects past the cap are reached
 * through **Move to project** in the chat's action menu, which is searchable.
 */
const visibleProjects = <T extends { id: string }>(projects: readonly T[], activeId: string | null): readonly T[] => {
  if (projects.length <= idleVisibleLimit) {
    return projects
  }
  const head = projects.slice(0, idleVisibleLimit)
  const active = projects.find((project) => project.id === activeId)
  return active && !head.includes(active) ? [...head, active] : head
}

/** The rows themselves, given a project list. */
export const ProjectDropRows = ({ projects, isDragging, draggingFromProjectId }: ProjectDropRowsProps) => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const location = useLocation()

  if (projects.length === 0) {
    return null
  }

  const activeId = location.pathname.startsWith('/projects/') ? location.pathname.slice('/projects/'.length) : null
  const visible = visibleProjects(projects, activeId)
  const hiddenCount = projects.length - visible.length

  return (
    <div
      className={cn(
        'rounded-lg transition-colors duration-150',
        // The group reads as one target zone during a drag, so it's obvious where a
        // chat can go before hovering any individual row. Background and an *inset*
        // ring only — the previous `p-1` grew the container by 8px the instant a
        // drag began, nudging every row below it out from under the pointer.
        isDragging && 'bg-sidebar-accent/40 ring-1 ring-inset ring-border',
      )}
    >
      {/* Same `SidebarGroupLabel` the chat list uses for "Recent Chats", so the
          two groups read as siblings rather than one labelled and one loose. A
          drag swaps the label for the drop-zone instruction — the rows mean
          something different for the duration of the gesture. */}
      <SidebarGroupLabel>
        {isDragging ? <Trans>Move to project</Trans> : <Trans>Recent Projects</Trans>}
      </SidebarGroupLabel>
      <SidebarMenu>
        {visible.map((project) => (
          <DropRow
            key={project.id}
            dropId={projectDropId(project.id)}
            label={project.name}
            icon={<ProjectIcon icon={project.icon} className="size-[var(--icon-size-default)] text-[1.05rem]" />}
            isDragging={isDragging}
            isCurrent={draggingFromProjectId === project.id}
            isActive={project.id === activeId}
            onClick={() => navigate(`/projects/${project.id}`)}
          />
        ))}
        {hiddenCount > 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => navigate('/projects')}
              // Deliberately never active: it's a shortcut to the projects page,
              // which the "Projects" item above already indicates.
              tooltip={t`All projects`}
              className="cursor-pointer text-muted-foreground"
            >
              <Ellipsis className="size-[var(--icon-size-default)]" aria-hidden="true" />
              <span className="truncate">{hiddenCount} more</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {/* Only meaningful when the chat is in a project. */}
        {isDragging && draggingFromProjectId !== null && (
          <DropRow
            dropId={unassignDropId}
            label={t`Remove from project`}
            icon={<FolderMinus className="size-[var(--icon-size-default)] text-muted-foreground" aria-hidden="true" />}
            isDragging
          />
        )}
      </SidebarMenu>
    </div>
  )
}

/** Live-data wrapper: the sidebar's project rows for the current account. */
export const ProjectDropList = (props: Omit<ProjectDropRowsProps, 'projects'>) => {
  const projects = useProjects()
  return <ProjectDropRows projects={projects} {...props} />
}
