/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLingui } from '@lingui/react/macro'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'

import type { Skill } from '@/types'
import { verticalAxisModifiers } from '@/lib/dnd'
import { cn } from '@/lib/utils'
import { skillDisplayName } from './display'

const SortableRow = ({ skill, locked }: { skill: Skill; locked: boolean }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: skill.id,
    disabled: locked,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex h-9 touch-none items-center gap-2 rounded-md px-2 ${
        locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
      } ${isDragging ? 'opacity-40' : 'hover:bg-accent'}`}
    >
      <GripVertical size={16} className={`shrink-0 text-muted-foreground ${locked ? 'invisible' : ''}`} />
      <span className="truncate text-[length:var(--font-size-body)] text-foreground">{skillDisplayName(skill)}</span>
    </div>
  )
}

export type ReorderMove = { id: string; from: number; to: number }

/**
 * Drawer-style reorder panel for pinned skills, shown in place of the
 * pinned-chips bar while the user is rearranging. On drag end, the
 * entire new order is reported to the parent along with the moved item's
 * id and indices (sourced from dnd-kit's `active.id` — the ground truth,
 * unambiguous even for adjacent swaps). Caller commits via `reorderPins(ids)`
 * (single transaction in the DAL). Locked rows stay fixed and cannot be
 * crossed by a drag.
 *
 * TouchSensor uses a 120ms delay so vertical page-scroll still works when
 * the user isn't actually dragging.
 */
export const ReorderPanel = ({
  pinned,
  onReorder,
  onClose,
  embedded = false,
  lockedIds = new Set<string>(),
}: {
  pinned: Skill[]
  onReorder: (ids: string[], move: ReorderMove) => void
  onClose: () => void
  embedded?: boolean
  lockedIds?: ReadonlySet<string>
}) => {
  const { t } = useLingui()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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
    const crossesLockedSkill = pinned
      .slice(Math.min(oldIndex, newIndex), Math.max(oldIndex, newIndex) + 1)
      .some((skill) => lockedIds.has(skill.id))
    if (crossesLockedSkill) {
      return
    }
    const next = arrayMove(pinned, oldIndex, newIndex)
    onReorder(
      next.map((s) => s.id),
      { id: String(active.id), from: oldIndex, to: newIndex },
    )
  }

  return (
    <div
      data-base-ui-swipe-ignore
      className={cn(
        'flex flex-col gap-2',
        embedded ? 'px-1 pb-2' : 'rounded-xl border border-border bg-card p-2 shadow-md',
      )}
    >
      {!embedded && (
        <div className="flex h-8 items-center gap-2 px-2">
          <span className="flex-1 text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Reorder skills</Trans>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`Close reorder`}
            className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={verticalAxisModifiers}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={pinned.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {pinned.map((skill) => (
            <SortableRow key={skill.id} skill={skill} locked={lockedIds.has(skill.id)} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}
