/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { Reply } from 'lucide-react'
import { type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useQuoteSelection } from './use-quote-selection'

/** Gap in px between the selection and the floating button. */
const gap = 8
/** Below this many px from the viewport top, place the button under the selection instead of above. */
const flipThreshold = 44

/**
 * Renders a floating "Reply" button over a text selection inside an assistant
 * response, and on click pulls the passage into the composer as a first-class
 * quote (via the per-thread pending-quotes store). Mounted once in the message
 * list. Portaled to the body so overflow/scroll containers don't clip it.
 */
export const QuoteReplyButton = () => {
  const { selection, clear } = useQuoteSelection()
  const threadId = useCurrentChatSession().id
  const addQuote = usePendingQuotesStore((s) => s.addQuote)
  const { isMobile } = useIsMobile()

  if (!selection) {
    return null
  }

  // On mobile, sit below the selection — closer to the thumbs and clear of iOS's
  // own selection menu, which appears above. On desktop, prefer above unless the
  // selection is near the viewport top.
  const placeAbove = !isMobile && selection.rect.top > flipThreshold
  const style: CSSProperties = {
    position: 'fixed',
    top: placeAbove ? selection.rect.top - gap : selection.rect.bottom + gap,
    left: selection.rect.left + selection.rect.width / 2,
    transform: `translate(-50%, ${placeAbove ? '-100%' : '0'})`,
  }

  const onReply = () => {
    addQuote(threadId, { text: selection.text, sourceMessageId: selection.sourceMessageId })
    clear()
  }

  return createPortal(
    <button
      type="button"
      style={style}
      // Keep the text selection (and focus) intact: pressing anywhere would
      // otherwise collapse it before onClick fires, hiding the button via
      // selectionchange. onPointerDown covers both mouse and touch — a plain
      // mousedown handler misses touch, which collapses the selection first.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onReply}
      className="z-50 flex items-center gap-1.5 rounded-full border bg-popover px-3.5 py-2 text-[length:var(--font-size-sm)] font-medium text-popover-foreground shadow-md transition hover:bg-muted"
    >
      <Reply className="size-4" aria-hidden="true" />
      Reply
    </button>,
    document.body,
  )
}
