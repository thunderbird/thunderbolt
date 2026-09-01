/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import { describe, expect, it } from 'bun:test'
import { buildCatalog, filterCatalog, loadEmojiCatalog, suggestedEmoji, toRows } from './emoji-catalog'

const data = {
  categories: [
    { id: 'objects', emojis: ['moneybag', 'card_index_dividers'] },
    { id: 'flags', emojis: ['flag_wales'] },
    { id: 'empty', emojis: ['missing_id'] },
  ],
  emojis: {
    moneybag: {
      id: 'moneybag',
      name: 'Money Bag',
      keywords: ['dollar', 'payment', 'coins', 'sale'],
      skins: [{ native: '💰' }],
    },
    card_index_dividers: {
      id: 'card_index_dividers',
      name: 'Card Index Dividers',
      keywords: ['organizing', 'business'],
      skins: [{ native: '🗂️' }],
    },
    // Some entries in the real data have no usable skin; they must be dropped
    // rather than rendering an empty button.
    flag_wales: { id: 'flag_wales', name: 'Flag for Wales', keywords: [], skins: [] },
  },
} as unknown as Parameters<typeof buildCatalog>[0]

describe('buildCatalog', () => {
  it('flattens categories with human labels', () => {
    const catalog = buildCatalog(data)
    expect(catalog.map((category) => i18n._(category.label))).toEqual(['Objects'])
  })

  it('drops entries with no glyph, and categories left empty', () => {
    const catalog = buildCatalog(data)
    // `flags` held only a skinless entry, and `empty` only an unknown id.
    expect(catalog.map((category) => category.id)).toEqual(['objects'])
  })

  it('builds a lowercased haystack from name plus keywords', () => {
    const [objects] = buildCatalog(data)
    const money = objects.emoji.find((entry) => entry.native === '💰')
    expect(money?.haystack).toContain('money bag')
    expect(money?.haystack).toContain('payment')
    expect(money?.haystack).toBe(money?.haystack.toLowerCase())
  })
})

describe('filterCatalog', () => {
  const catalog = buildCatalog(data)

  it('returns everything for an empty term', () => {
    expect(filterCatalog(catalog, '   ')[0].emoji).toHaveLength(2)
  })

  it('matches curated keywords, not just the official name', () => {
    // The reason this uses emoji-mart data rather than CLDR annotations: CLDR
    // tags for 🗂️ are card/dividers/index, which "organizing" would never hit.
    const hits = filterCatalog(catalog, 'organizing')
    expect(hits[0].emoji.map((entry) => entry.native)).toEqual(['🗂️'])
  })

  it('is case- and whitespace-insensitive', () => {
    expect(filterCatalog(catalog, '  PAYMENT ')[0].emoji.map((e) => e.native)).toEqual(['💰'])
  })

  it('finds an emoji pasted as the search term', () => {
    expect(filterCatalog(catalog, '🗂️')[0].emoji.map((e) => e.native)).toEqual(['🗂️'])
  })

  it('drops categories with no matches instead of rendering empty headings', () => {
    expect(filterCatalog(catalog, 'zzzznope')).toEqual([])
  })
})

describe('toRows', () => {
  it('chunks into fixed-width rows with a short final row', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ native: `${i}`, name: `${i}`, haystack: `${i}` }))
    const rows = toRows(entries, 9)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveLength(9)
    expect(rows[1]).toHaveLength(1)
  })

  it('returns nothing for an empty list', () => {
    expect(toRows([], 9)).toEqual([])
  })
})

describe('the real package', () => {
  it('loads the full set and finds an emoji by a curated keyword', async () => {
    const catalog = await loadEmojiCatalog()
    const total = catalog.reduce((sum, category) => sum + category.emoji.length, 0)
    // Sanity floor rather than an exact count, so a data-package bump doesn't
    // fail the suite for adding emoji.
    expect(total).toBeGreaterThan(1_500)

    const hits = filterCatalog(catalog, 'payment').flatMap((category) => category.emoji.map((e) => e.native))
    expect(hits).toContain('💰')
  })

  it('memoizes, so reopening the picker does not re-import', async () => {
    expect(await loadEmojiCatalog()).toBe(await loadEmojiCatalog())
  })

  it('every suggested glyph exists in the full catalogue', async () => {
    const catalog = await loadEmojiCatalog()
    const all = new Set(catalog.flatMap((category) => category.emoji.map((entry) => entry.native)))
    // Guards against a curated glyph drifting out of the data package (or a
    // variation-selector mismatch, which would silently break selection).
    const missing = suggestedEmoji.filter((emoji) => !all.has(emoji))
    expect(missing).toEqual([])
  })
})
