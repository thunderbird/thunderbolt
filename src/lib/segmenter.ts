/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `Intl.Segmenter` instances for user-written text.
 *
 * Deliberately not under `src/i18n/`, and nothing here reads the app locale:
 * the text these callers segment is written by the user, whose language is
 * independent of the UI language and routinely mixed within one account. An
 * `en` UI does not make a Japanese message English. Everything in `src/i18n/`
 * keys on the *app* locale; this keys on the content's own script.
 */

/**
 * `Intl.Segmenter`'s word segmentation is dictionary-driven, so the locale
 * picks the dictionary. Han without kana is treated as Chinese; kana anywhere
 * means Japanese.
 */
const segmenterLocales: readonly (readonly [RegExp, string])[] = [
  [/[\p{sc=Hiragana}\p{sc=Katakana}]/u, 'ja'],
  [/\p{sc=Thai}/u, 'th'],
  [/\p{sc=Khmer}/u, 'km'],
  [/\p{sc=Lao}/u, 'lo'],
  [/\p{sc=Myanmar}/u, 'my'],
]

/**
 * Segmentation locale implied by the text's own script.
 *
 * The `zh` fallback only decides the dictionary for text in an unsegmented
 * script that matched no rule above, i.e. bare Han. Spaced scripts break on
 * UAX #29 rules that carry no dictionary, so the tag is immaterial to them —
 * `en`, `de` and `zh` segment an English sentence identically.
 */
const segmenterLocaleFor = (text: string): string => segmenterLocales.find(([script]) => script.test(text))?.[1] ?? 'zh'

const segmenters = new Map<string, Intl.Segmenter | null>()

/**
 * Segmenters are cheap to use and expensive to build, so each one is kept for
 * the life of the tab. `null` is cached too: it means `Intl.Segmenter` itself
 * is missing (Firefox only shipped it in 125), which will not change.
 */
const memoized = (key: string, create: () => Intl.Segmenter): Intl.Segmenter | null => {
  const cached = segmenters.get(key)
  if (cached !== undefined) {
    return cached
  }
  const segmenter = typeof Intl.Segmenter === 'function' ? create() : null
  segmenters.set(key, segmenter)
  return segmenter
}

/**
 * Word segmenter for `text`, or `null` where `Intl.Segmenter` is missing.
 * Every caller needs its own degraded path for that `null` — what to do
 * without segmentation depends entirely on what the caller wanted it for.
 */
export const wordSegmenterFor = (text: string): Intl.Segmenter | null => {
  const locale = segmenterLocaleFor(text)
  return memoized(locale, () => new Intl.Segmenter(locale, { granularity: 'word' }))
}

/**
 * Grapheme segmenter, for cutting text that has no word boundary to cut on.
 *
 * Locale-independent by construction: grapheme cluster boundaries are UAX #29
 * rules over the text's own code points, with no dictionary to key on. The
 * cache key cannot collide with a locale tag, which never contains `_`.
 */
export const graphemeSegmenter = (): Intl.Segmenter | null =>
  memoized('_grapheme', () => new Intl.Segmenter(undefined, { granularity: 'grapheme' }))
