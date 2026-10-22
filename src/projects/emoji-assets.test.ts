/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync } from 'node:fs'
import { expect, it } from 'bun:test'
import { emojiAssetFilename } from './emoji-assets'
import { loadEmojiCatalog, suggestedEmoji } from './emoji-catalog'

it('handles presentation selectors, joined emoji, flags, and skin tones', () => {
  expect(emojiAssetFilename('🗂️')).toBe('1f5c2.svg')
  expect(emojiAssetFilename('🏳️‍🌈')).toBe('1f3f3-200d-1f308.svg')
  expect(emojiAssetFilename('🇩🇰')).toBe('1f1e9-1f1f0.svg')
  expect(emojiAssetFilename('👋🏽')).toBe('1f44b-1f3fd.svg')
})

it('ships an SVG for every suggested and selectable emoji', async () => {
  const files = readdirSync(new URL('../../node_modules/@twemoji/svg/', import.meta.url)).filter((name) =>
    name.endsWith('.svg'),
  )
  const assets = new Set(files.map((name) => name.replaceAll('-fe0f', '')))
  expect(assets.size).toBe(files.length)
  const catalog = await loadEmojiCatalog()
  const emoji = [...suggestedEmoji, ...catalog.flatMap((category) => category.emoji.map((entry) => entry.native))]
  expect(emoji.filter((native) => !assets.has(emojiAssetFilename(native)))).toEqual([])
})
