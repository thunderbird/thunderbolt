/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Unicode combining marks — the class `remove_diacritics 2` draws from. */
const combiningMark = /\p{M}/u
const combiningMarks = /\p{M}/gu

/**
 * Scripts whose combining marks are accents, and so safe to strip.
 *
 * Everywhere else a combining mark carries meaning rather than decoration and
 * has to survive: Japanese voicing (`が` is not `か`), Thai and Lao vowel signs,
 * Devanagari matras. SQLite's `remove_diacritics 2` draws the same line, so
 * stripping more here would highlight text the index never matched.
 */
const accentedScript = /^[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}]/u

export type FoldedText = {
  /** Case- and accent-folded text. */
  folded: string
  /**
   * Original-string index each UTF-16 unit of {@link folded} came from, plus a
   * final sentinel holding the original length. A folded span `[start, end)`
   * therefore maps back to `[offsets[start], offsets[end])`.
   */
  offsets: number[]
}

/**
 * Folds one code point. `stripMarks` carries whether the base character this
 * one may attach to takes accents — needed because the input can arrive already
 * decomposed, in which case a mark shows up as its own code point.
 */
const foldChar = (char: string, stripMarks: boolean): { folded: string; stripMarks: boolean } => {
  if (combiningMark.test(char)) {
    return { folded: stripMarks ? '' : char, stripMarks }
  }
  const decomposed = char.normalize('NFD')
  if (!accentedScript.test(decomposed)) {
    return { folded: char.toLowerCase(), stripMarks: false }
  }
  return { folded: decomposed.replace(combiningMarks, '').toLowerCase(), stripMarks: true }
}

/**
 * Folds text the way the FTS5 index does — accents stripped, lowercased — while
 * keeping a map back into the original string, so a match found on the folded
 * text can be sliced out of the original with its casing and diacritics intact.
 *
 * This mirrors `tokenize = 'unicode61 remove_diacritics 2'` (see
 * `buildCreateSql` in `fts-setup.ts`): the index matches `sao` against `São`,
 * so highlighting has to as well or it marks nothing on a hit the user can see.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: unicode61 folds
 * locale-independently, so folding with the UI locale here would desync
 * highlighting from what actually matched (Turkish dotted-i being the classic
 * way to notice).
 */
export const foldForMatch = (text: string): FoldedText => {
  const parts: string[] = []
  const offsets: number[] = []
  let index = 0
  let stripMarks = false
  for (const char of text) {
    const result = foldChar(char, stripMarks)
    stripMarks = result.stripMarks
    parts.push(result.folded)
    // One offset per UTF-16 unit, not per code point, so folded indices line up
    // with `String.prototype.indexOf`.
    for (let unit = 0; unit < result.folded.length; unit += 1) {
      offsets.push(index)
    }
    index += char.length
  }
  offsets.push(text.length)
  return { folded: parts.join(''), offsets }
}
