/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PageSearch } from '@/components/ui/page-search'
import { useAgentRegistrySearch } from '@/hooks/use-agent-registry-search'
import type { RegistryEntry } from '@/types/registry'
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

  return (
    <section className="flex flex-col gap-3">
      <PageSearch onSearch={setQuery}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Browse agents</h2>
          <PageSearch.Button />
        </div>

        <PageSearch.Input
          placeholder="Search agents"
          onSearch={setQuery}
          wrapperClassName="pr-0"
          className="h-9 rounded-lg border-border bg-card text-sm placeholder:text-muted-foreground"
        />
      </PageSearch>
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
