/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolve a point to the element under it.
 *
 * This is the *only* thing the app has to contribute to element picking —
 * Thunderbolt captures the pointer, draws the outline and the label, and decides
 * what counts as a click. It asks this question as the pointer moves, because it
 * cannot see inside a cross-origin frame.
 *
 * The default below works on any markup, so an app that does nothing still gets
 * usable results. Apps that want clean, semantic answers mark their meaningful
 * nodes with `data-tb-select` (and optionally `data-tb-label`), which the default
 * prefers over guessing from tag names.
 *
 * Answer quickly. One of these rides every throttled pointer move, and
 * Thunderbolt gives up after ~600ms — a slow answer shows as an outline that
 * lags the cursor.
 */

export type SelectionItem = {
  id: string
  label: string
  text: string
  data?: unknown
}

export type Rect = { x: number; y: number; width: number; height: number }

/** An element plus the geometry Thunderbolt needs to outline it. */
export type HighlightedElement = SelectionItem & { rect: Rect }

/** Fallback candidates when the app hasn't marked anything up. */
const defaultCandidateSelector = '[data-tb-select], tr, li, blockquote, figure, p, h1, h2, h3, h4, h5, h6'

/** Cap matching the protocol's, applied here so we never build a huge payload. */
const maxTextLength = 5_000

const toRect = (bounds: DOMRect): Rect => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width,
  height: bounds.height,
})

/** A short, human label for a chip. */
const labelFor = (element: Element, index: number): string => {
  const explicit = element.getAttribute('data-tb-label')
  if (explicit) {
    return explicit
  }
  const firstCell = element.querySelector('td, th')?.textContent?.trim()
  if (firstCell) {
    return firstCell
  }
  const text = element.textContent?.trim() ?? ''
  return text.length > 0 ? `${text.slice(0, 40)}${text.length > 40 ? '…' : ''}` : `Item ${index + 1}`
}

/**
 * Read a row of a table as `Header: value` pairs rather than a run of bare
 * numbers, so "4,214,000" reaches the model attached to the column it came from.
 */
const describeTableRow = (row: Element): string | null => {
  const cells = Array.from(row.querySelectorAll('td'))
  if (cells.length === 0) {
    return null
  }
  const table = row.closest('table')
  const headers = Array.from(table?.querySelectorAll('thead th') ?? []).map((th) => th.textContent?.trim() ?? '')
  if (headers.length !== cells.length) {
    return cells.map((cell) => cell.textContent?.trim() ?? '').join(' | ')
  }
  return cells.map((cell, index) => `${headers[index]}: ${cell.textContent?.trim() ?? ''}`).join(', ')
}

/**
 * Find the meaningful element under a point.
 *
 * Walks up from whatever leaf sits at the coordinate to the nearest candidate,
 * so pointing at a `<td>` gives the whole row and pointing at a `<span>` inside
 * a heading gives the heading. Returns `null` over padding or a background —
 * a normal answer, not a failure.
 */
export const elementAtPoint = (
  point: { x: number; y: number },
  selector = defaultCandidateSelector,
): HighlightedElement | null => {
  const hit = document.elementFromPoint(point.x, point.y)
  const element = hit?.closest(selector)
  if (!element) {
    return null
  }

  const text = describeTableRow(element) ?? element.textContent?.trim() ?? ''
  if (text.length === 0) {
    return null
  }

  const rect = toRect(element.getBoundingClientRect())
  return {
    // Stable while the element is, so Thunderbolt can tell "the pointer moved
    // within one element" from "it moved to another".
    id: `${labelFor(element, 0)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
    label: labelFor(element, 0),
    text: text.slice(0, maxTextLength),
    rect,
  }
}
