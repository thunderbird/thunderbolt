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
 * to remove it from.
 */

import { useDroppable } from '@dnd-kit/core'
import { FolderMinus } from 'lucide-react'
import { useNavigate } from 'react-router'

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
  onClick?: () => void
}

const DropRow = ({ dropId, label, icon, isDragging, isCurrent, onClick }: DropRowProps) => {
  const { setNodeRef, isOver } = useDroppable({ id: dropId, disabled: isCurrent })

  return (
    <SidebarMenuItem ref={setNodeRef}>
      <SidebarMenuButton
        onClick={onClick}
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

export const ProjectDropList = ({ isDragging, draggingFromProjectId }: ProjectDropListProps) => {
  const projects = useProjects()
  const navigate = useNavigate()

  if (projects.length === 0) {
    return null
  }

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
        {projects.map((project) => (
          <DropRow
            key={project.id}
            dropId={projectDropId(project.id)}
            label={project.name}
            icon={<ProjectIcon icon={project.icon} className="size-[var(--icon-size-default)] text-[1.05rem]" />}
            isDragging={isDragging}
            isCurrent={draggingFromProjectId === project.id}
            onClick={() => navigate(`/projects/${project.id}`)}
          />
        ))}
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
