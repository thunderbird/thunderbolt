/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import type { SurfaceRect } from './types'
import { MessageSquareQuote } from 'lucide-react'

/** Gap between the selection and the control, in px. */
const offset = 8
/** Below this much room above the selection, the control flips underneath. */
const flipThreshold = 44

export type SelectionPopoverPlacement = {
  left: number
  top: number
  /** True when the control sits below the selection because there was no room above. */
  flipped: boolean
}

/**
 * Place the control horizontally centred on the selection and above it, flipping
 * below when the selection is too close to the top of the frame.
 *
 * The rect arrives in the *guest's* viewport coordinates. The iframe fills its
 * container edge to edge, so those coordinates are also container coordinates —
 * no offset math is needed, and internal scrolling is already accounted for
 * because the guest reports a live `getBoundingClientRect()`.
 *
 * Exported separately from the component so the geometry can be tested without
 * a DOM.
 */
export const placeSelectionPopover = (rect: SurfaceRect): SelectionPopoverPlacement => {
  const flipped = rect.y < flipThreshold
  return {
    left: rect.x + rect.width / 2,
    top: flipped ? rect.y + rect.height + offset : rect.y - offset,
    flipped,
  }
}

type SelectionPopoverProps = {
  rect: SurfaceRect
  onAsk: () => void
}

/**
 * The "Ask about this" control that floats over highlighted text in an embedded
 * surface — a Mini App or an artifact.
 *
 * Rendered by Thunderbolt rather than by the guest: the assistant is the host's,
 * so a surface gets this affordance — correctly styled, and identical across
 * both — purely by reporting selections over its bridge.
 */
export const SelectionPopover = ({ rect, onAsk }: SelectionPopoverProps) => {
  const { left, top, flipped } = placeSelectionPopover(rect)
  return (
    <div
      className="absolute z-20 pointer-events-none"
      style={{
        left,
        top,
        transform: `translate(-50%, ${flipped ? '0' : '-100%'})`,
      }}
    >
      <Button size="sm" onClick={onAsk} className="pointer-events-auto shadow-lg rounded-full">
        <MessageSquareQuote className="size-[var(--icon-size-sm)]" />
        <Trans>Ask about this</Trans>
      </Button>
    </div>
  )
}
