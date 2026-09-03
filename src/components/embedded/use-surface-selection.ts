/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The element-picking gesture, once, for both embedded surfaces.
 *
 * The user turns picking on, moves the pointer over the surface, and the element
 * under it outlines itself. Clicking takes that element to the composer.
 *
 * This replaced a marquee: drag a box, and the guest returned everything inside
 * it. Two things were wrong with that. Aiming a rectangle at one row of a table
 * is fiddly, and a rectangle forces the guest to guess which of the overlapping
 * things the user meant — so it answered with a list, which then needed a
 * confirm step to review, which is a lot of ceremony for "tell me about this".
 * Pointing at one element is unambiguous, so the answer needs no review: the
 * outline *is* the confirmation, and the click is the decision.
 *
 * Placement stays with each caller — a Mini App floats a large control beside
 * its chat toggle, an artifact card a small one in its corner — because that
 * difference is real. The states, the transitions and the passage formatting
 * are not.
 */

import { useCallback, useReducer, useRef } from 'react'

import { toSelectionPassages } from './selection-passage'
import type { SurfaceHighlightedElement } from './types'

export type SurfaceSelectionMode =
  | { kind: 'idle' }
  /**
   * Picking is on. `element` is whatever the guest last said was under the
   * pointer, or null over padding and background — a normal answer, not a
   * failure. `token` is the query this state is showing the answer to, so a
   * slow reply for an earlier position can't overwrite a newer one.
   */
  | { kind: 'picking'; element: SurfaceHighlightedElement | null; token: number }

type Action =
  | { type: 'pickingStarted' }
  | { type: 'pointerMoved'; token: number }
  | { type: 'elementResolved'; token: number; element: SurfaceHighlightedElement | null }
  | { type: 'dismissed' }

/**
 * One state machine rather than a boolean plus a nullable element, so "not
 * picking" and "showing an outline" can't both be true.
 *
 * The `token` guard is the same one the marquee needed and for the same reason:
 * these queries are issued on every throttled pointer move and answered out of
 * order under load, so without it the outline jumps back to a position the
 * pointer has already left.
 */
const modeReducer = (mode: SurfaceSelectionMode, action: Action): SurfaceSelectionMode => {
  switch (action.type) {
    case 'pickingStarted':
      return { kind: 'picking', element: null, token: 0 }
    case 'pointerMoved':
      // Keep the current outline while the next answer is in flight. Clearing it
      // here would make the outline strobe as the pointer moves.
      return mode.kind === 'picking' ? { ...mode, token: action.token } : mode
    case 'elementResolved':
      return mode.kind === 'picking' && mode.token === action.token ? { ...mode, element: action.element } : mode
    case 'dismissed':
      return { kind: 'idle' }
  }
}

export type SurfaceSelectionDeps = {
  /** Ask the guest what sits under a point. Resolves null on anything odd. */
  query: (point: { x: number; y: number }) => Promise<SurfaceHighlightedElement | null>
  /** Attach the chosen passage to the composer as a quote chip. */
  onAsk: (passages: string[]) => void
}

export const useSurfaceSelection = ({ query, onAsk }: SurfaceSelectionDeps) => {
  const [mode, dispatch] = useReducer(modeReducer, { kind: 'idle' })
  const lastQueryToken = useRef(0)

  const startPicking = useCallback(() => dispatch({ type: 'pickingStarted' }), [])
  const dismiss = useCallback(() => dispatch({ type: 'dismissed' }), [])

  const pointAt = useCallback(
    async (point: { x: number; y: number }) => {
      // A ref rather than reducer state: the token has to be readable here, in
      // the same tick as the dispatch, and a dispatch doesn't hand back what it
      // produced.
      const token = ++lastQueryToken.current
      dispatch({ type: 'pointerMoved', token })
      dispatch({ type: 'elementResolved', token, element: await query(point) })
    },
    [query],
  )

  /** Take the highlighted element to the composer. */
  const askAboutElement = useCallback(
    (element: SurfaceHighlightedElement) => {
      onAsk(toSelectionPassages([element]))
      dispatch({ type: 'dismissed' })
    },
    [onAsk],
  )

  return { mode, startPicking, dismiss, pointAt, askAboutElement }
}
