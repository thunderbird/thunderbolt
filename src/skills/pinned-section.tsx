/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, MoreHorizontal, Pin, PinOff, Play, SquarePen, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import type { Skill } from '@/types'

type PinnedRowProps = {
  skill: Skill
  isActive: boolean
  enabled: boolean
  onSelect: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onTogglePin: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

const PinnedRow = ({
  skill,
  isActive,
  enabled,
  onSelect,
  onToggleEnabled,
  onTogglePin,
  onEdit,
  onDelete,
}: PinnedRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: skill.id })
  const navigate = useNavigate()

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <li ref={setNodeRef} style={style}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(skill.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(skill.id)
          }
        }}
        className={`group flex h-[var(--touch-height-default)] w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 text-base transition-colors ${
          enabled ? 'text-foreground' : 'text-muted-foreground/60'
        } ${isActive ? 'bg-accent' : 'hover:bg-accent'}`}
      >
        <button
          type="button"
          aria-label={`Drag to reorder /${skill.name}`}
          // Listeners attach the drag handle to dnd-kit; stop propagation so
          // the click doesn't double-fire the row's select handler.
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>
        <span className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Switch
            checked={enabled}
            onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
            aria-label={enabled ? `Disable /${skill.name}` : `Enable /${skill.name}`}
          />
        </span>
        <Pin size={14} className="shrink-0 fill-current text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">/{skill.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Open ${skill.name} menu`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-foreground/10 aria-expanded:opacity-100"
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(skill.id)
              }}
              className="cursor-pointer"
            >
              <PinOff />
              Unpin
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onEdit(skill.id)
              }}
              className="cursor-pointer"
            >
              <SquarePen />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                navigate('/', { state: { runSkill: skill.name } })
              }}
              className="cursor-pointer"
            >
              <Play />
              Run in chat
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onDelete(skill.id)
              }}
              className="cursor-pointer"
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

/**
 * Pinned-skills subsection with drag-to-reorder. Rendered above the main
 * library list when at least one skill is pinned. The 10-pin cap is enforced
 * in the DAL; this UI never sees more than 10 rows.
 */
export const PinnedSection = ({
  pinned,
  activeSkillId,
  isEnabled,
  onToggleEnabled,
  onTogglePin,
  onSelectSkill,
  onEdit,
  onDelete,
  onReorder,
}: {
  pinned: Skill[]
  activeSkillId: string | null
  isEnabled: (id: string) => boolean
  onToggleEnabled: (id: string, next: boolean) => void
  onTogglePin: (id: string) => void
  onSelectSkill: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (ids: string[]) => void
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (pinned.length === 0) {
    return null
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) {
      return
    }
    const oldIndex = pinned.findIndex((s) => s.id === active.id)
    const newIndex = pinned.findIndex((s) => s.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }
    const next = arrayMove(pinned, oldIndex, newIndex)
    onReorder(next.map((s) => s.id))
  }

  return (
    <div className="flex flex-col gap-1">
      <h2 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pinned</h2>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pinned.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-0.5">
            {pinned.map((skill) => (
              <PinnedRow
                key={skill.id}
                skill={skill}
                isActive={skill.id === activeSkillId}
                enabled={isEnabled(skill.id)}
                onSelect={onSelectSkill}
                onToggleEnabled={onToggleEnabled}
                onTogglePin={onTogglePin}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  )
}
