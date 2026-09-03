/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns a raw user query into the two match strategies the FTS5 index supports.
 *
 * FTS5 ships no word-segmenting tokenizer (`unicode61`, `ascii`, `porter`,
 * `trigram` — there is no ICU tokenizer for FTS5), so the index is built with
 * `unicode61 remove_diacritics 2`: correct for every script that separates
 * words with spaces, useless for the ones that don't. `東京の天気はどうですか`
 * tokenizes as a single word, which is why searching `天気` used to return
 * nothing at all.
 *
 * Terms in those scripts are therefore matched with `LIKE '%term%'` rather than
 * MATCH — an exact substring test at *any* length, including the one- and
 * two-character terms that dominate Japanese and Chinese. (A parallel `trigram`
 * index was measured and rejected: it costs ~2.2× the source text in extra
 * storage and silently drops terms shorter than three characters from a MATCH,
 * so it would need this same path underneath it anyway.)
 *
 * Nothing here reads the app locale, deliberately. The index holds user
 * content, whose language is independent of the UI language and routinely mixed
 * within one account — a locale-keyed plan would be wrong for most rows in
 * exactly the accounts it is meant to help. `wordSegmenterFor` derives its
 * dictionary from the query's own script for the same reason.
 */

import { wordSegmenterFor } from '@/lib/segmenter'

/**
 * Scripts whose words are not separated by spaces, so `unicode61` collapses a
 * whole run into one token.
 *
 * Hangul is deliberately absent: Korean *does* space its phrases, so
 * `unicode61` tokenizes it correctly, and the prefix `*` already reaches its
 * agglutinated suffixes (`서울` finds `서울에서`).
 */
const unsegmentedScript = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u

/**
 * Splits one whitespace token containing an unsegmented script into words.
 *
 * Single-character words are dropped as grammatical particles (`の`, `は`) —
 * they would match nearly every row — unless dropping them would leave
 * nothing, which is how a legitimate one-character query like `犬` survives.
 * A mixed token splits at its script boundary, so `Claude設定` yields a
 * MATCH-able `Claude` alongside a substring `設定`.
 */
const segment = (token: string): string[] => {
  const segmenter = wordSegmenterFor(token)
  if (!segmenter) {
    // Without segmentation an unsegmented run stays a single substring term,
    // which still matches contiguous text — just not `東京天気` against
    // `東京の天気`.
    return [token]
  }
  const words = [...segmenter.segment(token)].filter((part) => part.isWordLike === true).map((part) => part.segment)
  const meaningful = words.filter((word) => word.length > 1)
  return meaningful.length > 0 ? meaningful : words
}

/** FTS5 string literal, quotes doubled per FTS5 escaping, with prefix match. */
const quoteForMatch = (term: string): string => `"${term.replace(/"/g, '""')}"*`

export type SearchQueryPlan = {
  /**
   * FTS5 MATCH expression, or `null` when every term needs substring matching
   * (a query written entirely in an unsegmented script).
   */
  match: string | null
  /**
   * Raw terms to match with `LIKE`. Raw, not escaped: the SQL site needs the
   * literal form for `instr()` and the escaped form for `LIKE` — see
   * {@link toLikePattern}.
   */
  substrings: string[]
}

/**
 * Escapes the three `LIKE` wildcards and wraps the term for a contains match.
 * Without this a query containing `%` matches every row. Pair with
 * `ESCAPE '\'` at the SQL site.
 */
export const toLikePattern = (term: string): string => `%${term.replace(/[\\%_]/g, '\\$&')}%`

/**
 * The terms a query actually matches on: whitespace-split, then any token in an
 * unsegmented script split into words.
 *
 * Exported because highlighting has to agree with matching. `HighlightMatch`
 * marks these same terms, so a particle-omitted query like `東京天気` — which
 * matches a row containing `東京の天気` — highlights `東京` and `天気` rather
 * than hunting for a literal `東京天気` that isn't there.
 */
export const planQueryTerms = (raw: string): string[] =>
  raw
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .flatMap((token) => (unsegmentedScript.test(token) ? segment(token) : [token]))

/**
 * Plans a raw user query: each term from {@link planQueryTerms} routed by
 * script — matched as a substring where `unicode61` cannot tokenize it, quoted
 * into a prefix MATCH otherwise. `sao 天気` becomes
 * `{ match: '"sao"*', substrings: ['天気'] }`, and the two are ANDed at the
 * SQL site.
 */
export const planSearchQuery = (raw: string): SearchQueryPlan => {
  const terms = planQueryTerms(raw)
  const matchTokens = terms.filter((term) => !unsegmentedScript.test(term)).map(quoteForMatch)
  return {
    match: matchTokens.length > 0 ? matchTokens.join(' ') : null,
    substrings: terms.filter((term) => unsegmentedScript.test(term)),
  }
}
