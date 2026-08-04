/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@powersync/tanstack-react-query'
import { searchEntities } from './registry'
import type { SearchEntityType, SearchResult, UseSearch } from './types'

/** Entity type → its registry config, for O(1) route/display lookup per hit. */
const configByType = new Map(searchEntities.map((cfg) => [cfg.type, cfg]))

/** Raw column shape returned by {@link searchSql}. */
type SearchRow = {
  id: string
  entity_type: SearchEntityType
  parent_id: string | null
  title: string | null
  snippet: string
}

/**
 * bm25 weights title 10x over body; `snippet(…, 4, …)` extracts a highlighted
 * excerpt from the body column (index 4) truncated to 15 tokens. bm25 weights
 * are positional over every column, so the three leading UNINDEXED columns
 * (id, entity_type, parent_id) take a no-op 1.0 before title's 10x boost.
 */
const searchSql =
  `SELECT id, entity_type, parent_id, title, ` +
  `snippet(search_index, 4, '', '', '…', 15) AS snippet ` +
  `FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0), id LIMIT 50`

/**
 * Sanitizes a raw user query into safe FTS5 MATCH syntax: whitespace-split into
 * tokens, each double-quoted (embedded quotes doubled per FTS5 escaping) and
 * suffixed with `*` for prefix matching. `hello wor` becomes `"hello"* "wor"*`.
 * Quoting neutralizes FTS5 operators (`-`, `*`, `:`, `"`) inside a token.
 */
export const toFtsMatchQuery = (raw: string): string =>
  raw
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' ')

/** Maps one raw FTS row to a display-ready, navigable {@link SearchResult}. */
const toResult = (row: SearchRow): SearchResult => {
  const config = configByType.get(row.entity_type)
  if (!config) {
    throw new Error(`[search] No registry config for entity type '${row.entity_type}'`)
  }
  return {
    id: row.id,
    entityType: row.entity_type,
    // Titleless entities (messages) index an empty title, so the snippet is the
    // only text — leave title empty and let the row promote the snippet rather
    // than duplicating it onto both lines.
    title: row.title ?? '',
    snippet: row.snippet,
    to: config.route({ id: row.id, parentId: row.parent_id }),
  }
}

/**
 * Reactive full-text search over the unified index. Returns no results for an
 * empty/whitespace query. Debouncing is the caller's concern — this tolerates
 * rapid calls but does not delay them.
 */
export const useSearch: UseSearch = (query) => {
  const match = toFtsMatchQuery(query)
  const enabled = match.length > 0
  const { data, isLoading } = useQuery<SearchRow>({
    queryKey: ['search', match],
    query: searchSql,
    parameters: [match],
    enabled,
    // Keep the prior results visible while the next query resolves so the list
    // updates in place instead of flickering empty on every keystroke.
    placeholderData: (previousData) => previousData,
  })

  if (!enabled) {
    return { results: [], isLoading: false }
  }
  return { results: (data ?? []).map(toResult), isLoading }
}
