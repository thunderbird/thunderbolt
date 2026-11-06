/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CommandItem } from '@/components/ui/command'
import { HighlightMatch } from '../highlight'
import type { SearchEntityType, SearchResult } from '../types'
import { entityIcons } from './entity-meta'

/**
 * One row in the palette: entity icon, highlighted title, and a muted,
 * truncated, highlighted snippet. Selecting it hands `result.to` back to the
 * palette; the palette routes entities with an inline editor (Models, Skills,
 * Agents) straight to their edit panel and navigates everything else to its
 * page.
 */
export const SearchResultItem = ({
  result,
  query,
  onSelect,
}: {
  result: SearchResult
  query: string
  onSelect: (to: string, entityType: SearchEntityType, id: string) => void
}) => {
  const Icon = entityIcons[result.entityType]

  // Messages have no title, so the snippet is the row's primary text; everything
  // else shows title as primary with the snippet as a muted secondary line.
  const primaryText = result.title || result.snippet
  const secondaryText = result.title ? result.snippet : ''

  return (
    <CommandItem
      // cmdk filters/keys off `value`; include the id so identical titles stay
      // distinct, and the visible text so its built-in filter keeps real hits.
      value={`${result.title} ${result.snippet} ${result.id}`}
      onSelect={() => onSelect(result.to, result.entityType, result.id)}
      className="items-start gap-2 rounded-md"
    >
      <Icon className="mt-0.5 size-[var(--icon-size-sm)] shrink-0" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[length:var(--font-size-body)]">
          <HighlightMatch text={primaryText} query={query} />
        </span>
        {secondaryText ? (
          <span className="text-muted-foreground truncate text-[length:var(--font-size-xs)]">
            <HighlightMatch text={secondaryText} query={query} />
          </span>
        ) : null}
      </div>
    </CommandItem>
  )
}
