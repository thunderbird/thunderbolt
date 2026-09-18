/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A tool that searches the *other* chats in the current project.
 *
 * Registered only for a thread that belongs to a project, so it costs nothing —
 * not even a line of tool schema — in an ordinary chat.
 *
 * **This is keyword search, not semantic search.** It runs against the app's
 * FTS5 index (`search_index`, unicode61, BM25 with titles weighted 10×);
 * there is no embedding model or vector store anywhere in the app. A question
 * phrased differently from the original conversation will simply miss. The tool
 * description therefore instructs the model to expand its own query into
 * synonyms and retry, which is the cheap substitute for semantic recall — models
 * are good at generating vocabulary variants, and each attempt is a local
 * SQLite query costing no tokens beyond the call itself.
 *
 * Injecting sibling transcripts into the prompt instead was rejected
 * deliberately: it would blow the context budget, and it would change the
 * *stable* prompt every time any other chat in the project got a message,
 * invalidating the prompt cache on every send.
 */

import { sql } from 'drizzle-orm'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { planSearchQuery, toLikePattern } from '@/search/query-plan'
import { bm25Sql, bodyColumnIndex } from '@/search/search-sql'

/** One hit: which chat it came from, and the matching excerpt. */
export type ProjectChatHit = {
  chatThreadId: string
  chatTitle: string
  excerpt: string
}

/**
 * One raw result row, **positional**: `[parent_id, snippet]`.
 *
 * Both SQLite backends go through drizzle's `sqlite-proxy` driver (see
 * `src/db/wa-sqlite-database.ts` and `src/db/bun-sqlite-database.ts`), which
 * hands raw `db.all()` results back as arrays, not keyed objects — a raw query
 * carries no column metadata for drizzle to map. Reading `row.parent_id` here
 * yields `undefined` for every row and silently returns zero hits.
 */
type SearchRow = readonly [parentId: string | null, snippet: string | null]

const maxHits = 8

/** Body characters kept before, and in total around, a substring hit. */
const excerptLead = 24
const excerptLength = 160

/**
 * Search messages belonging to a set of threads. Kept separate from the tool so
 * it can be tested without constructing an AI SDK tool call.
 */
export const searchProjectChats = async (
  db: AnyDrizzleDatabase,
  threadIds: readonly string[],
  query: string,
  titleByThreadId: ReadonlyMap<string, string>,
): Promise<ProjectChatHit[]> => {
  const plan = planSearchQuery(query)
  if ((plan.match === null && plan.substrings.length === 0) || threadIds.length === 0) {
    return []
  }
  // `parent_id` is UNINDEXED in the FTS table, so it can't participate in MATCH;
  // it's filtered in the WHERE clause alongside it. Values are bound (never
  // interpolated) — the query is user/model-supplied text.
  const threadList = sql.join(
    threadIds.map((id) => sql`${id}`),
    sql`, `,
  )
  // Scripts unicode61 can't tokenize are matched as substrings instead of via
  // MATCH — see `src/search/query-plan.ts`.
  const substringFilters = plan.substrings.map((term) => {
    const pattern = toLikePattern(term)
    return sql`(title LIKE ${pattern} ESCAPE '\\' OR body LIKE ${pattern} ESCAPE '\\')`
  })
  const filter = sql.join(
    plan.match !== null ? [sql`search_index MATCH ${plan.match}`, ...substringFilters] : substringFilters,
    sql` AND `,
  )
  // `snippet()` needs a MATCH, so a substring-only query centres a window on the
  // first hit instead. Unlike the palette's variant in `use-search.ts` this skips
  // the truncation ellipses — the model has no use for them. Ranking falls back
  // to `id DESC`: bm25 has nothing to score, and ids are UUIDv7, so that is
  // newest-first (see `uuidv7ToDate` in `src/lib/utils.ts`).
  const excerpt =
    plan.match !== null
      ? sql.raw(`snippet(search_index, ${bodyColumnIndex}, '', '', '…', 30)`)
      : sql`substr(body, max(1, instr(body, ${plan.substrings[0]}) - ${excerptLead}), ${excerptLength})`
  const rows = (await db.all(sql`
    SELECT parent_id, ${excerpt} AS snippet
    FROM search_index
    WHERE ${filter}
      AND entity_type = 'message'
      AND parent_id IN (${threadList})
    ORDER BY ${plan.match !== null ? sql.raw(bm25Sql) : sql`id DESC`}
    LIMIT ${maxHits}
  `)) as SearchRow[]
  return rows.flatMap(([parentId, snippet]) =>
    parentId
      ? [
          {
            chatThreadId: parentId,
            chatTitle: titleByThreadId.get(parentId) ?? 'Untitled chat',
            excerpt: snippet ?? '',
          },
        ]
      : [],
  )
}

export type ProjectSearchToolContext = {
  db: AnyDrizzleDatabase
  projectName: string
  /** Sibling threads to search — the current chat is excluded by the caller,
   *  since its own history is already in context. */
  threadIds: readonly string[]
  titleByThreadId: ReadonlyMap<string, string>
}

/**
 * Build the `search_project_chats` tool. Returns a formatted digest rather than
 * raw rows so the model gets the source chat title with each excerpt and can
 * attribute what it found.
 */
export const createProjectSearchTool = ({
  db,
  projectName,
  threadIds,
  titleByThreadId,
}: ProjectSearchToolContext): Tool<{ query: string }, string> =>
  tool({
    description:
      `Search earlier conversations in the "${projectName}" project for something the user already discussed. ` +
      'This is KEYWORD search over message text — it matches words, not meaning, so a query using different ' +
      'vocabulary than the original conversation will return nothing. If the first search comes up empty, try ' +
      'again with synonyms and related terms before concluding the topic was never discussed ' +
      '(e.g. "pricing" → "price", "cost", "charge", "revenue"). Does not search the current chat.',
    inputSchema: z.object({
      query: z.string().describe('Keywords to look for. Prefer distinctive nouns over full sentences.'),
    }),
    execute: async ({ query }) => {
      const hits = await searchProjectChats(db, threadIds, query, titleByThreadId)
      return formatProjectChatHits(hits, query)
    },
  })

/**
 * Render hits for the model. An empty result says *why* it might be empty, so
 * the model retries with other wording instead of asserting the topic never
 * came up — the single most likely failure mode of a lexical index.
 */
export const formatProjectChatHits = (hits: readonly ProjectChatHit[], query: string): string => {
  if (hits.length === 0) {
    return `No messages in this project's other chats matched "${query}". This is a keyword search, so try different wording or related terms before telling the user it wasn't discussed.`
  }
  return hits.map((hit) => `From "${hit.chatTitle}":\n${hit.excerpt}`).join('\n\n')
}
