/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turning marquee-selected items into composer quotes.
 *
 * Two things this fixes over the naive `label\ntext` join:
 *
 * 1. **`data` reaches the model.** The protocol has always let an app return a
 *    structured payload per item from `resolveSelection`, and nothing consumed
 *    it — so an app that went to the trouble of handing over domain objects got
 *    exactly the same result as one that let the default hit-test scrape text.
 *    That made the better path pointless, which is the same as not having it.
 *
 *    Shared with artifacts, which used to do the naive join this file was
 *    written to replace — so a thirty-row artifact marquee buried the composer
 *    in thirty chips while the same gesture in a Mini App produced one.
 *
 * 2. **A wide drag doesn't bury the composer.** Selecting a dozen rows used to
 *    produce a dozen chips the user then had to read past to find their own
 *    prompt. Past a small threshold they collapse into one passage, which is
 *    also more honest — they were one gesture, not a dozen decisions.
 */

import type { SurfaceSelectionItem } from './types'

/**
 * Above this many items, collapse to a single passage.
 *
 * Three is where a stack of chips stops reading as "the things I picked" and
 * starts reading as clutter.
 */
export const collapseChipsAbove = 3

/** Cap on serialised `data` per item, so one fat payload can't eat the context. */
const maxDataChars = 2_000

const renderItem = (item: SurfaceSelectionItem): string => {
  const body = `${item.label}\n${item.text}`
  if (item.data === undefined) {
    return body
  }
  // structuredClone (which postMessage uses) can carry cycles, so this really
  // can throw — and the app controls the value. Losing the whole selection over
  // one bad payload would be a poor trade; drop the payload, keep the text.
  const serialised = ((): string | null => {
    try {
      return JSON.stringify(item.data) ?? null
    } catch {
      return null
    }
  })()

  if (serialised === null || serialised.length > maxDataChars) {
    return body
  }
  return `${body}\n${serialised}`
}

/**
 * Build the passages to attach to the composer.
 *
 * Returns one string per chip: either one per item, or a single combined
 * passage once there are enough of them to be noise.
 */
export const toSelectionPassages = (items: SurfaceSelectionItem[]): string[] => {
  if (items.length === 0) {
    return []
  }
  if (items.length <= collapseChipsAbove) {
    return items.map(renderItem)
  }
  return [`${items.length} selected items\n\n${items.map(renderItem).join('\n\n')}`]
}
