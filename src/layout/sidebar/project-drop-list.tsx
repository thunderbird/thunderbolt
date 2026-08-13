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
 * to remove it from. A drag also lifts the idle row cap, so no project is
 * unreachable as a drop target.
 */

import { useDroppable } from '@dnd-kit/core'
import { Ellipsis, FolderMinus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useProjects } from '@/dal/projects'
import { cn } from '@/lib/utils'
import { projectDropId, unassignDropId } from '@/projects/chat-drop'
import { ProjectIcon } from '@/projects/project-icon'

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
  const { setNodeRef, isOver } = useDroppable({ id: dropId, disabled: isCurrent })

  return (
    <SidebarMenuItem ref={setNodeRef}>
      <SidebarMenuButton
        onClick={onClick}
        isActive={isActive}
        tooltip={isCurrent ? `${label} — already in this project` : label}
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
            {isOver ? 'Drop' : ''}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

type ProjectDropListProps = {
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
 * The rows to render. Capped when idle, but never during a drag — every project
 * has to stay reachable as a drop target — and the open project is always
 * included, so the active row can't be the one that got collapsed away.
 */
const visibleProjects = <T extends { id: string }>(
  projects: T[],
  isDragging: boolean,
  activeId: string | null,
): T[] => {
  if (isDragging || projects.length <= idleVisibleLimit) {
    return projects
  }
  const head = projects.slice(0, idleVisibleLimit)
  const active = projects.find((project) => project.id === activeId)
  return active && !head.includes(active) ? [...head, active] : head
}

export const ProjectDropList = ({ isDragging, draggingFromProjectId }: ProjectDropListProps) => {
  const projects = useProjects()
  const navigate = useNavigate()
  const location = useLocation()

  if (projects.length === 0) {
    return null
  }

  const activeId = location.pathname.startsWith('/projects/') ? location.pathname.slice('/projects/'.length) : null
  const visible = visibleProjects(projects, isDragging, activeId)
  const hiddenCount = projects.length - visible.length

  return (
    <div
      className={cn(
        'rounded-lg transition-colors duration-150',
        // The group reads as one target zone during a drag, so it's obvious where
        // a chat can go before hovering any individual row.
        isDragging && 'bg-sidebar-accent/40 p-1 ring-1 ring-border',
      )}
    >
      {isDragging && (
        <p className="px-2 pt-1 pb-1.5 text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
          Move to project
        </p>
      )}
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
              tooltip="All projects"
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
            label="Remove from project"
            icon={<FolderMinus className="size-[var(--icon-size-default)] text-muted-foreground" aria-hidden="true" />}
            isDragging
          />
        )}
      </SidebarMenu>
    </div>
  )
}
