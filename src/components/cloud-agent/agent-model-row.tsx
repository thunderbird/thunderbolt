/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** Only the handle initiates dragging so toggling a model never reorders it. */
export const AgentModelRow = ({
  id,
  name,
  isDefault,
  enabled,
  onToggle,
}: {
  id: string
  name: string
  isDefault: boolean
  enabled: boolean
  onToggle: (enabled: boolean) => void
}) => {
  const { t } = useLingui()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/model relative flex items-center gap-2 rounded-lg py-1 text-sm',
        isDragging && 'z-10 bg-card shadow-sm',
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        size="icon-xs"
        variant="ghost"
        {...attributes}
        {...listeners}
        aria-label={t`Reorder ${name}`}
        className={cn(
          'shrink-0 cursor-grab touch-none text-muted-foreground transition-opacity active:cursor-grabbing motion-reduce:transition-none',
          !isDragging &&
            '[@media(hover:hover)]:opacity-0 group-hover/model:opacity-100 group-focus-within/model:opacity-100',
        )}
      >
        <GripVertical />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{name}</span>
        {isDefault && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            <Trans>Default</Trans>
          </span>
        )}
      </div>
      <Switch aria-label={t`Use ${name}`} checked={enabled} onCheckedChange={onToggle} />
    </div>
  )
}
