/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'

const SortableItem = ({ name }: { name: string }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: name })
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
      className={`flex h-8 touch-none items-center gap-1.5 rounded-xl px-2 cursor-grab active:cursor-grabbing ${
        isDragging ? 'opacity-40' : 'hover:bg-bg-hover'
      }`}
    >
      <GripVertical size={20} className="shrink-0 text-muted-foreground" />
      <span className="text-base leading-5 text-foreground">{name}</span>
    </div>
  )
}

export const ReorderPanel = ({
  skills,
  onMove,
  onClose,
}: {
  skills: string[]
  onMove: (name: string, index: number) => void
  onClose: () => void
}) => {
  // PointerSensor handles mouse + pen; TouchSensor handles touch with a small
  // press delay so vertical scroll on the page still works when not dragging.
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
    const toIdx = skills.indexOf(String(over.id))
    if (toIdx === -1) {
      return
    }
    onMove(String(active.id), toIdx)
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-strong bg-card px-2 py-3 shadow-md">
      <div className="flex flex-col gap-2">
        <div className="flex h-8 items-center gap-1.5 px-2">
          <span className="flex-1 text-base leading-5 text-muted-foreground">Reorder skills</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close reorder"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={skills} strategy={verticalListSortingStrategy}>
            {skills.map((name) => (
              <SortableItem key={name} name={name} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}
