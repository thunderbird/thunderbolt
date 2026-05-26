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
import { GripVertical, Pin } from 'lucide-react'

import type { Skill } from '@/types'

type PinnedRowProps = {
  skill: Skill
  isActive: boolean
  onSelect: (id: string) => void
}

const PinnedRow = ({ skill, isActive, onSelect }: PinnedRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: skill.id })

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
          isActive ? 'bg-accent' : 'hover:bg-accent'
        }`}
      >
        <button
          type="button"
          aria-label={`Drag to reorder ${skill.name}`}
          // Listeners attach the drag handle to dnd-kit; stop propagation so
          // the click doesn't double-fire the row's select handler.
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>
        <Pin size={14} className="shrink-0 fill-current text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-foreground">{skill.name}</span>
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
  onSelectSkill,
  onReorder,
}: {
  pinned: Skill[]
  activeSkillId: string | null
  onSelectSkill: (id: string) => void
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
              <PinnedRow key={skill.id} skill={skill} isActive={skill.id === activeSkillId} onSelect={onSelectSkill} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  )
}
