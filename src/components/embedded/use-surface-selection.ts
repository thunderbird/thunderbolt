/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The marquee gesture, once, for both embedded surfaces.
 *
 * It was written twice. The artifact copy modelled the flow as a reducer, with a
 * comment explaining that the two-flag version it replaced "allowed a result bar
 * to sit pinned over an active marquee"; the Mini App copy was still the two
 * flags, carrying that exact defect plus a hand-written `retrySelect` to paper
 * over it. Sharing the state machine means the fix is structural rather than
 * remembered.
 *
 * Placement stays with each caller — a Mini App floats a large control in a row
 * beside its Chat button, an artifact card a small one in its corner — because
 * that difference is real. The states, the transitions and the passage
 * formatting are not.
 */

import { useCallback, useReducer, useRef } from 'react'

import { toSelectionPassages } from './selection-passage'
import type { SurfaceRect, SurfaceSelectionItem } from './types'

export type SurfaceSelectionMode =
  | { kind: 'idle' }
  | { kind: 'drawing' }
  /**
   * The drag is released and the guest has been asked, but hasn't answered.
   * `token` identifies which release we are waiting on — the overlay stays
   * mounted through this state, so a second box can be drawn before the first
   * query returns.
   */
  | { kind: 'resolving'; token: number }
  /** The guest answered; an empty array is a real answer ("nothing there"). */
  | { kind: 'reviewing'; items: SurfaceSelectionItem[] }

type Action =
  | { type: 'marqueeStarted' }
  | { type: 'marqueeReleased'; token: number }
  | { type: 'marqueeAnswered'; token: number; items: SurfaceSelectionItem[] }
  | { type: 'dismissed' }

/**
 * One state machine rather than a boolean plus a nullable array, so "drawing"
 * and "reviewing" can't both be true.
 *
 * `resolving` is the state the Mini App copy lacked: it dropped out of drawing
 * before awaiting the guest, so for up to the query timeout the dim vanished,
 * the floating buttons popped back, a stale popover could reappear, and then the
 * result bar slammed in. It read as "my drag did nothing", and the fix is to
 * have a state for "asked, still waiting" rather than to reorder two setters.
 */
const modeReducer = (mode: SurfaceSelectionMode, action: Action): SurfaceSelectionMode => {
  switch (action.type) {
    case 'marqueeStarted':
      return { kind: 'drawing' }
    case 'marqueeReleased':
      return { kind: 'resolving', token: action.token }
    case 'marqueeAnswered':
      // Ignored unless we are still waiting for *this* answer. Two guards in
      // one: a late answer to a drag the user has since cancelled must not
      // resurrect the review bar, and a slow answer for box A must not be shown
      // as the contents of box B, drawn while A was still in flight.
      return mode.kind === 'resolving' && mode.token === action.token
        ? { kind: 'reviewing', items: action.items }
        : mode
    case 'dismissed':
      return { kind: 'idle' }
  }
}

export type SurfaceSelectionDeps = {
  /** Ask the guest what a rectangle covered. Resolves empty on anything odd. */
  query: (rect: SurfaceRect) => Promise<SurfaceSelectionItem[]>
  /** Attach the chosen passages to the composer as quote chips. */
  onAsk: (passages: string[]) => void
}

export const useSurfaceSelection = ({ query, onAsk }: SurfaceSelectionDeps) => {
  const [mode, dispatch] = useReducer(modeReducer, { kind: 'idle' })
  const lastReleaseToken = useRef(0)

  const startMarquee = useCallback(() => dispatch({ type: 'marqueeStarted' }), [])
  const dismiss = useCallback(() => dispatch({ type: 'dismissed' }), [])

  const resolveMarquee = useCallback(
    async (rect: SurfaceRect) => {
      // A ref rather than reducer state: the token has to be readable here, in
      // the same tick as the dispatch, and a dispatch doesn't hand back what it
      // produced.
      const token = ++lastReleaseToken.current
      dispatch({ type: 'marqueeReleased', token })
      dispatch({ type: 'marqueeAnswered', token, items: await query(rect) })
    },
    [query],
  )

  /** Take the reviewed items to the composer. */
  const askAboutItems = useCallback(
    (items: SurfaceSelectionItem[]) => {
      onAsk(toSelectionPassages(items))
      dispatch({ type: 'dismissed' })
    },
    [onAsk],
  )

  return { mode, startMarquee, dismiss, resolveMarquee, askAboutItems }
}
