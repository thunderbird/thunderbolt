/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react'

/** Marks an element whose text can be quoted; its value is the source message id. */
export const quotableMessageIdAttr = 'data-quotable-message-id'

export type QuoteSelection = {
  /** The trimmed selected text. */
  text: string
  /** The message the passage was selected from (provenance). */
  sourceMessageId: string
  /** Viewport rect of the selection, for anchoring the floating button. */
  rect: DOMRect
}

/** The quotable container the selection sits in, or null if it spans none/many. */
const quotableContainerOf = (range: Range): Element | null => {
  const node = range.commonAncestorContainer
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  // `.closest` on the common ancestor naturally rejects selections that span two
  // messages: their shared ancestor sits above any single quotable container.
  return el?.closest(`[${quotableMessageIdAttr}]`) ?? null
}

/**
 * Tracks a text selection made inside an assistant response (an element marked
 * with {@link quotableMessageIdAttr}) so a floating "Reply" button can anchor to
 * it. Returns the current selection (text + provenance + rect) or null, plus a
 * `clear` to dismiss it. DOM event listeners with cleanup — a legitimate effect.
 */
export const useQuoteSelection = (): { selection: QuoteSelection | null; clear: () => void } => {
  const [selection, setSelection] = useState<QuoteSelection | null>(null)

  const clear = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    // A settled selection (pointer/key released) — show the button if it's a
    // non-empty selection within a single quotable assistant message.
    const evaluate = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        return setSelection(null)
      }
      const text = sel.toString().trim()
      const range = sel.getRangeAt(0)
      const container = quotableContainerOf(range)
      const sourceMessageId = container?.getAttribute(quotableMessageIdAttr)
      if (!text || !sourceMessageId) {
        return setSelection(null)
      }
      setSelection({ text, sourceMessageId, rect: range.getBoundingClientRect() })
    }

    // Hide as soon as the selection collapses (e.g. a click elsewhere). Live
    // drags stay non-collapsed, so the button only appears on release.
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) {
        setSelection(null)
      }
    }

    // The anchored rect goes stale on scroll/resize — simplest correct behavior
    // is to dismiss and let the user re-select.
    const hide = () => setSelection(null)

    document.addEventListener('mouseup', evaluate)
    document.addEventListener('keyup', evaluate)
    document.addEventListener('touchend', evaluate)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('mouseup', evaluate)
      document.removeEventListener('keyup', evaluate)
      document.removeEventListener('touchend', evaluate)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  return { selection, clear }
}
