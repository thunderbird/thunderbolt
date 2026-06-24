/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SearchInput } from '@/components/ui/search-input'
import { useAgentRegistrySearch } from '@/hooks/use-agent-registry-search'
import type { RegistryEntry } from '@/types/registry'
import { useRef } from 'react'
import { AgentCatalogCard } from './agent-catalog-card'

type AgentCatalogViewProps = {
  /** The agents to render. Always non-empty in production (the snapshot seeds it). */
  entries: ReadonlyArray<RegistryEntry>
}

/** Presentational catalogue: search + grid of read-only agent cards. Takes its
 *  entries as a prop and owns no data fetching, so it renders purely from inputs
 *  and is unit-testable without react-query. */
export const AgentCatalogView = ({ entries }: AgentCatalogViewProps) => {
  const { query, setQuery, results, isEmpty } = useAgentRegistrySearch(entries)
  const showEmptyState = isEmpty && query.trim().length > 0
  const searchRef = useRef<HTMLInputElement>(null)

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Browse agents</h2>
      <SearchInput
        ref={searchRef}
        showIcon
        placeholder="Search agents"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {showEmptyState ? (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground py-6 text-center">No agents found</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {results.map((entry) => (
            <AgentCatalogCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  )
}
