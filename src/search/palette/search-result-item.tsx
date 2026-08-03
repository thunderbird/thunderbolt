/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CommandItem } from '@/components/ui/command'
import { Pencil, Trash2 } from 'lucide-react'
import type { MouseEvent, PointerEvent } from 'react'
import { getEntityActions } from '../actions/entity-actions'
import type { EntityActionType } from '../actions/types'
import { HighlightMatch } from '../highlight'
import type { SearchEntityType, SearchResult } from '../types'
import { entityIcons } from './entity-meta'

/**
 * Stops a nested button's click/pointer event from bubbling to the parent
 * `CommandItem`, which would otherwise fire the row's `onSelect` (cmdk treats
 * any pointer event on the row as a selection). Needed on BOTH `onClick` and
 * `onPointerDown`.
 */
const stopRowSelect = (event: MouseEvent | PointerEvent) => {
  event.stopPropagation()
  event.preventDefault()
}

/**
 * One row in the palette: entity icon, highlighted title, and a muted,
 * truncated, highlighted snippet. Selecting it hands `result.to` back to the
 * palette to navigate and close. Entities that support inline edit/remove
 * (Models + Skills in v1) reveal trailing icon buttons on hover/focus that
 * fire `onAction` instead of navigating.
 */
export const SearchResultItem = ({
  result,
  query,
  onSelect,
  onAction,
}: {
  result: SearchResult
  query: string
  onSelect: (to: string, entityType: SearchEntityType) => void
  onAction: (entityType: SearchEntityType, action: EntityActionType, id: string) => void
}) => {
  const Icon = entityIcons[result.entityType]
  const supports = getEntityActions(result.entityType)?.supports

  const renderAction = (action: EntityActionType, ActionIcon: typeof Pencil, label: string) => (
    <button
      type="button"
      aria-label={label}
      onPointerDown={stopRowSelect}
      onClick={(event) => {
        stopRowSelect(event)
        onAction(result.entityType, action, result.id)
      }}
      className="hover:bg-accent hover:text-accent-foreground rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      <ActionIcon className="size-[var(--icon-size-sm)]" />
    </button>
  )

  return (
    <CommandItem
      // cmdk filters/keys off `value`; include the id so identical titles stay
      // distinct, and the visible text so its built-in filter keeps real hits.
      value={`${result.title} ${result.snippet} ${result.id}`}
      onSelect={() => onSelect(result.to, result.entityType)}
      className="group items-start gap-2 rounded-md"
    >
      <Icon className="mt-0.5 size-[var(--icon-size-sm)] shrink-0" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[length:var(--font-size-body)]">
          <HighlightMatch text={result.title} query={query} />
        </span>
        {result.snippet ? (
          <span className="text-muted-foreground truncate text-[length:var(--font-size-xs)]">
            <HighlightMatch text={result.snippet} query={query} />
          </span>
        ) : null}
      </div>
      {supports?.edit || supports?.remove ? (
        <div className="ml-auto flex items-center gap-1">
          {supports.edit ? renderAction('edit', Pencil, 'Edit') : null}
          {supports.remove ? renderAction('remove', Trash2, 'Remove') : null}
        </div>
      ) : null}
    </CommandItem>
  )
}
