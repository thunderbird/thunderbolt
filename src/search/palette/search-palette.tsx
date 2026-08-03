/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandList } from '@/components/ui/command'
import { useDebounce } from '@/hooks/use-debounce'
import { trackEvent } from '@/lib/posthog'
import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { searchEntities } from '../registry'
import type { SearchEntityType, SearchResult } from '../types'
import { useSearch } from '../use-search'
import { entityLabels } from './entity-meta'
import { RecentChatsGroup } from './recent-chats-group'
import { SearchResultItem } from './search-result-item'

const debounceMs = 180

/**
 * Groups results by entity type, preserving the registry's ordering so the
 * palette always lists types in the same, intentional sequence.
 */
const groupByEntity = (results: SearchResult[]) =>
  searchEntities
    .map((entity) => ({ entity, hits: results.filter((result) => result.entityType === entity.type) }))
    .filter((group) => group.hits.length > 0)

/**
 * The Cmd+K command palette modal. Owns the debounced query, drives `useSearch`,
 * and renders grouped results (or recent chats when the query is empty).
 */
export const SearchPalette = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, debounceMs)
  const trimmedQuery = debouncedQuery.trim()
  const hasQuery = trimmedQuery.length > 0

  const { results, isLoading } = useSearch(hasQuery ? trimmedQuery : '')
  const groups = useMemo(() => (hasQuery ? groupByEntity(results) : []), [hasQuery, results])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery('')
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange],
  )

  const handleSelect = useCallback(
    (to: string, entityType: SearchEntityType) => {
      trackEvent('search_result_select', { entityType })
      handleOpenChange(false)
      navigate(to)
    },
    [handleOpenChange, navigate],
  )

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Search"
      description="Search across chats, models, skills, agents, and more"
      className="rounded-2xl"
    >
      <CommandInput placeholder="Search chats, models, skills, agents…" value={query} onValueChange={setQuery} />
      <CommandList>
        {!hasQuery ? (
          <RecentChatsGroup onSelect={handleSelect} />
        ) : isLoading ? (
          <CommandEmpty>Searching…</CommandEmpty>
        ) : (
          <>
            <CommandEmpty>No results found.</CommandEmpty>
            {groups.map(({ entity, hits }) => (
              <CommandGroup key={entity.type} heading={entityLabels[entity.type]}>
                {hits.map((result) => (
                  <SearchResultItem
                    key={`${result.entityType}-${result.id}`}
                    result={result}
                    query={trimmedQuery}
                    onSelect={handleSelect}
                  />
                ))}
              </CommandGroup>
            ))}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
