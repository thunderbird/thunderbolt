/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * State and derivations behind the emoji picker's body: the search box, the
 * lazily-imported catalogue, and the category label pinned above the grid.
 *
 * Kept out of the component so `EmojiPickerBody` is pure display, and so the
 * load and scroll logic can be exercised without mounting a popover.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { VirtualizerHandle } from 'virtua'

import { filterCatalog, loadEmojiCatalog, toRows, type EmojiCategory, type EmojiEntry } from './emoji-catalog'

/** Emoji per row. Desktop fits 9 in a 19rem popover; the sheet is full-width. */
export const desktopPerRow = 9
export const mobilePerRow = 8

/**
 * Flatten categories into emoji rows, plus the category each row belongs to.
 *
 * The label is carried *alongside* the rows rather than as a heading row in the
 * list, because the heading has to stay pinned while its category scrolls. A
 * heading rendered in flow can't do that here: `virtua` unmounts rows that leave
 * the viewport, so `position: sticky` on one would vanish the moment it scrolled
 * out — which is exactly when it needs to stick.
 */
export const toGridRows = (
  categories: readonly EmojiCategory[],
  perRow: number,
): { rows: EmojiEntry[][]; labelByRow: string[] } => {
  const rows: EmojiEntry[][] = []
  const labelByRow: string[] = []
  for (const category of categories) {
    for (const entries of toRows(category.emoji, perRow)) {
      rows.push(entries)
      labelByRow.push(category.label)
    }
  }
  return { rows, labelByRow }
}

/**
 * Drives the emoji picker's body for one opening.
 *
 * @param isMobile - Wider grid and larger cells on touch, which changes `perRow`.
 */
export const useEmojiPickerState = (isMobile: boolean) => {
  const [search, setSearch] = useState('')
  // `'failed'` rather than a separate flag: the load has three outcomes, and one
  // slot keeps them mutually exclusive.
  const [catalog, setCatalog] = useState<EmojiCategory[] | 'failed' | null>(null)
  // Which row sits at the top of the viewport. Derived from the scroll offset via
  // the virtualizer rather than tracked per row, so the pinned label stays correct
  // even when the rows it describes have been unmounted.
  const [topRow, setTopRow] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const perRow = isMobile ? mobilePerRow : desktopPerRow

  // Legitimate effect: fetching from an external module on mount. The catalogue
  // module memoizes a *successful* load, so reopening never re-imports — and it
  // does not cache a failure, so reopening after one really does retry.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const loaded = await loadEmojiCatalog()
        if (!cancelled) {
          setCatalog(loaded)
        }
      } catch (error) {
        // A rejected dynamic import (offline, or a chunk 404 after a redeploy)
        // would otherwise leave the body on "Loading emoji…" forever.
        console.warn('Failed to load the emoji catalogue', error)
        if (!cancelled) {
          setCatalog('failed')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const { rows, labelByRow } = useMemo(
    () =>
      catalog && catalog !== 'failed'
        ? toGridRows(filterCatalog(catalog, search), perRow)
        : { rows: [], labelByRow: [] },
    [catalog, search, perRow],
  )

  const showSuggested = search.trim().length === 0

  return {
    search,
    setSearch,
    catalog,
    rows,
    perRow,
    showSuggested,
    pinnedLabel: showSuggested ? labelByRow[Math.min(topRow, labelByRow.length - 1)] : undefined,
    scrollRef,
    virtualizerRef,
    handleScroll: (offset: number) => setTopRow(virtualizerRef.current?.findItemIndex(offset) ?? 0),
  }
}
