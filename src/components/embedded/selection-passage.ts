/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turning a picked surface element into a composer quote.
 *
 * What this does over the naive `label\ntext` join: **`data` reaches the
 * model.** The protocol has always let an app return a structured payload
 * alongside the text, and nothing consumed it — so an app that went to the
 * trouble of handing over domain objects got exactly the same result as one
 * that let the default hit-test scrape text. That made the better path
 * pointless, which is the same as not having it.
 *
 * Shared with artifacts, which did the naive join separately, so the same
 * gesture used to produce a different result on the two surfaces.
 *
 * One element in, one passage out. There was a multi-item collapse here for the
 * rect marquee, which returned a list; element picking answers with a single
 * `SurfaceHighlightedElement`, so the collapse became unreachable and went with
 * the gesture.
 */

import type { SurfaceSelectionItem } from './types'

/** Cap on serialised `data`, so one fat payload can't eat the context. */
const maxDataChars = 2_000

/** Render one picked item as the passage text attached to the composer. */
export const toSelectionPassage = (item: SurfaceSelectionItem): string => {
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
