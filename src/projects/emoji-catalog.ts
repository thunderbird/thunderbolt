/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * The full Unicode emoji set, loaded on demand.
 *
 * `@emoji-mart/data` is **dynamically imported** so its ~79 KB gzipped never
 * touches the entry chunk — the same technique `src/acp/built-in-adapter.ts`
 * uses for the Pi engine. Only someone who opens the picker downloads it, once.
 *
 * We take the *data* package, not `emoji-mart` itself: its keywords are curated
 * associations (💰 → dollar, payment, coins, sale) rather than the CLDR
 * annotations in `emojibase`, which are just the official name split into words
 * (🗂️ → card, dividers, index). Associations are what make a search box feel
 * like it understands intent. Skipping the React component keeps our own grid
 * and design system.
 */

/** Shape of the slice of `@emoji-mart/data` we consume. */
type EmojiMartData = {
  categories: { id: string; emojis: string[] }[]
  emojis: Record<string, { id: string; name: string; keywords?: string[]; skins: { native: string }[] }>
}

/** One selectable emoji, flattened for rendering and search. */
export type EmojiEntry = {
  /** The glyph itself — what gets stored on the project. */
  native: string
  /** CLDR display name, used as the accessible label and tooltip. */
  name: string
  /** Pre-lowercased haystack (name + keywords), built once at load. */
  haystack: string
}

export type EmojiCategory = {
  id: string
  /** Descriptor, not a string: the built catalog is cached for the process
   *  lifetime, so a resolved heading would freeze at whatever locale was active
   *  the first time the picker opened. Resolved at render instead. */
  label: MessageDescriptor
  emoji: EmojiEntry[]
}

/** Human headings for emoji-mart's category ids. */
const categoryLabels: Record<string, MessageDescriptor> = {
  people: msg`Smileys & people`,
  nature: msg`Animals & nature`,
  foods: msg`Food & drink`,
  activity: msg`Activity`,
  places: msg`Travel & places`,
  objects: msg`Objects`,
  symbols: msg`Symbols`,
  flags: msg`Flags`,
}

/**
 * A short list of glyphs that stay legible at the 16px the sidebar renders them
 * at, offered above the full set. Much of the full catalogue (detailed flags,
 * multi-person sequences) is an indistinct smudge at that size, so the good
 * choices should still be one click away rather than buried behind search.
 */
export const suggestedEmoji: readonly string[] = [
  '📁',
  '📊',
  '📈',
  '📝',
  '📌',
  '🗂️',
  '📅',
  '💼',
  '🧾',
  '🗒️',
  '🛠️',
  '⚙️',
  '🧩',
  '🔧',
  '🧪',
  '🔬',
  '🧠',
  '💡',
  '🎯',
  '🚀',
  '🌍',
  '🏛️',
  '⚖️',
  '🏥',
  '🎓',
  '🔐',
  '💰',
  '📡',
  '🌱',
  '⚡',
  '🎨',
  '🎬',
  '🎵',
  '📷',
  '🕹️',
  '☕',
  '🏔️',
  '🐝',
  '🌤️',
  '✨',
]

/** Flatten the package's id-keyed map into render-ready categories. */
export const buildCatalog = (data: EmojiMartData): EmojiCategory[] =>
  data.categories
    .map((category) => ({
      id: category.id,
      // Unknown ids fall back to the raw id as an untranslatable descriptor, so
      // callers have one type to resolve.
      label: categoryLabels[category.id] ?? { id: category.id, message: category.id },
      emoji: category.emojis.flatMap((id) => {
        const record = data.emojis[id]
        const native = record?.skins?.[0]?.native
        if (!record || !native) {
          return []
        }
        return [
          {
            native,
            name: record.name,
            // Built once here rather than per keystroke: filtering 1,870 entries
            // on every character is the hot path in this component.
            haystack: [record.name, ...(record.keywords ?? [])].join(' ').toLowerCase(),
          },
        ]
      }),
    }))
    .filter((category) => category.emoji.length > 0)

let cached: EmojiCategory[] | null = null

/** Load (and memoize) the catalogue. Safe to call on every popover open. */
export const loadEmojiCatalog = async (): Promise<EmojiCategory[]> => {
  if (cached) {
    return cached
  }
  const data = (await import('@emoji-mart/data')).default as EmojiMartData
  cached = buildCatalog(data)
  return cached
}

/**
 * Filter categories by a search term, dropping any that end up empty. An empty
 * term returns the catalogue untouched.
 */
export const filterCatalog = (categories: readonly EmojiCategory[], term: string): EmojiCategory[] => {
  const needle = term.trim().toLowerCase()
  if (needle.length === 0) {
    return [...categories]
  }
  return categories
    .map((category) => ({
      ...category,
      // Matching the glyph too, so pasting an emoji locates it.
      emoji: category.emoji.filter((entry) => entry.haystack.includes(needle) || entry.native === term.trim()),
    }))
    .filter((category) => category.emoji.length > 0)
}

/** Chunk a category's emoji into fixed-width rows for the virtualized grid. */
export const toRows = (emoji: readonly EmojiEntry[], perRow: number): EmojiEntry[][] => {
  const rows: EmojiEntry[][] = []
  for (let i = 0; i < emoji.length; i += perRow) {
    rows.push(emoji.slice(i, i + perRow))
  }
  return rows
}
