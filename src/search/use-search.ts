/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@powersync/tanstack-react-query'
import { planSearchQuery, toLikePattern, type SearchQueryPlan } from './query-plan'
import { searchEntities } from './registry'
import { bm25Sql, bodyColumnIndex } from './search-sql'
import type { SearchEntityType, SearchResult, UseSearch } from './types'

/** Entity type → its registry config, for O(1) route/display lookup per hit. */
const configByType = new Map(searchEntities.map((cfg) => [cfg.type, cfg]))

/** Raw column shape returned by {@link buildSearchStatement}. */
type SearchRow = {
  id: string
  entity_type: SearchEntityType
  parent_id: string | null
  title: string | null
  snippet: string
}

const resultLimit = 50

/** Excerpt from the body column, 15 tokens wide. */
const matchSnippetSql = `snippet(search_index, ${bodyColumnIndex}, '', '', '…', 15)`

/** Body characters kept before, and in total around, a substring hit. */
const snippetLead = 16
const snippetLength = 80

const snippetStart = `max(1, instr(body, ?) - ${snippetLead})`

/**
 * Snippet for the substring path. FTS5's `snippet()` requires a MATCH, so
 * centre a window on the first hit instead and mark either end that got cut
 * with the same `…` the MATCH path uses. The term is bound three times —
 * PowerSync binds positionally, so there is no named-parameter alternative.
 * A title-only hit yields `instr(body, …) = 0` and so an empty snippet, which
 * is correct: the title is already selected alongside it.
 *
 * Both guards test for a character the window does not reach: `substr` starting
 * at S covers S…S+length-1, so a tail exists at S+length, and the head is cut
 * once S moves past 1 (offset > lead + 1).
 */
const substringSnippetSql =
  `(CASE WHEN instr(body, ?) > ${snippetLead + 1} THEN '…' ELSE '' END) || ` +
  `substr(body, ${snippetStart}, ${snippetLength}) || ` +
  `(CASE WHEN length(body) >= ${snippetStart} + ${snippetLength} THEN '…' ELSE '' END)`

/**
 * One substring term against both indexed columns. `ESCAPE '\'` pairs with the
 * wildcard escaping {@link toLikePattern} applies.
 */
const likeClause = `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`

/** A ready-to-run statement and its positional bindings. */
export type SearchStatement = {
  sql: string
  parameters: string[]
}

/**
 * Builds the statement for a plan. Substring terms are ANDed onto the MATCH
 * (so `sao 天気` requires both), and a plan with no MATCH at all falls back to
 * `ORDER BY id DESC`: bm25 has nothing to score, and every indexed row's id is
 * a UUIDv7, which sorts lexicographically by creation time (see `uuidv7ToDate`
 * in `src/lib/utils.ts`) — so that is newest-first for free.
 */
export const buildSearchStatement = (plan: SearchQueryPlan): SearchStatement => {
  const likeSql = plan.substrings.map(() => likeClause).join(' AND ')
  const likeParameters = plan.substrings.flatMap((term) => {
    const pattern = toLikePattern(term)
    return [pattern, pattern]
  })

  // An empty plan lands in the MATCH branch: `useSearch` never runs it, but it
  // still has to produce syntactically valid SQL.
  if (plan.match !== null || plan.substrings.length === 0) {
    return {
      sql:
        `SELECT id, entity_type, parent_id, title, ${matchSnippetSql} AS snippet ` +
        `FROM search_index WHERE search_index MATCH ?${likeSql ? ` AND ${likeSql}` : ''} ` +
        `ORDER BY ${bm25Sql}, id LIMIT ${resultLimit}`,
      parameters: [plan.match ?? '', ...likeParameters],
    }
  }

  const [snippetTerm] = plan.substrings
  return {
    sql:
      `SELECT id, entity_type, parent_id, title, ${substringSnippetSql} AS snippet ` +
      `FROM search_index WHERE ${likeSql} ` +
      `ORDER BY id DESC LIMIT ${resultLimit}`,
    parameters: [snippetTerm, snippetTerm, snippetTerm, ...likeParameters],
  }
}

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
  const plan = planSearchQuery(query)
  const enabled = plan.match !== null || plan.substrings.length > 0
  const statement = buildSearchStatement(plan)
  const { data, isLoading } = useQuery<SearchRow>({
    queryKey: ['search', plan.match, plan.substrings],
    query: statement.sql,
    parameters: statement.parameters,
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
