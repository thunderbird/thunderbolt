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

import { toPickedPassage } from './picked-passage'
import type { SurfaceHighlightedElement } from './types'

export type ElementPickMode =
  | { kind: 'idle' }
  /**
   * Picking is on. `element` is whatever the guest last said was under the
   * pointer, or null over padding and background — a normal answer, not a
   * failure. `token` is the newest query issued; `answeredToken` is the one
   * `element` actually answers, so a slow reply for an earlier position can't
   * overwrite a newer one — and a click arriving mid-flight can tell that the
   * outline it is looking at is already out of date.
   */
  | {
      kind: 'picking'
      element: SurfaceHighlightedElement | null
      token: number
      answeredToken: number
    }

type Action =
  | { type: 'PICKING_STARTED' }
  | { type: 'POINTER_MOVED'; token: number }
  | { type: 'ELEMENT_RESOLVED'; token: number; element: SurfaceHighlightedElement | null }
  | { type: 'DISMISSED' }

/**
 * One state machine rather than a boolean plus a nullable element, so "not
 * picking" and "showing an outline" can't both be true.
 *
 * The `token` guard is the same one the marquee needed and for the same reason:
 * these queries are issued on every throttled pointer move and answered out of
 * order under load, so without it the outline jumps back to a position the
 * pointer has already left.
 */
const modeReducer = (mode: ElementPickMode, action: Action): ElementPickMode => {
  switch (action.type) {
    case 'PICKING_STARTED':
      return { kind: 'picking', element: null, token: 0, answeredToken: 0 }
    case 'POINTER_MOVED':
      // Keep the current outline while the next answer is in flight. Clearing it
      // here would make the outline strobe as the pointer moves.
      return mode.kind === 'picking' ? { ...mode, token: action.token } : mode
    case 'ELEMENT_RESOLVED':
      return mode.kind === 'picking' && mode.token === action.token
        ? { ...mode, element: action.element, answeredToken: action.token }
        : mode
    case 'DISMISSED':
      return { kind: 'idle' }
  }
}

export type ElementPickingDeps = {
  /** Ask the guest what sits under a point. Resolves null on anything odd. */
  query: (point: { x: number; y: number }) => Promise<SurfaceHighlightedElement | null>
  /** Attach the chosen passage to the composer as a quote chip. */
  onAsk: (passages: string[]) => void
}

export const useElementPicking = ({ query, onAsk }: ElementPickingDeps) => {
  const [mode, dispatch] = useReducer(modeReducer, { kind: 'idle' })
  const lastQueryToken = useRef(0)
  /**
   * Which gesture is live. Incremented on every start and every dismissal, so
   * work awaiting a guest reply can tell that the gesture it belongs to is over.
   */
  const gestureRef = useRef(0)

  const startPicking = useCallback(() => {
    gestureRef.current += 1
    dispatch({ type: 'PICKING_STARTED' })
  }, [])
  const dismiss = useCallback(() => {
    gestureRef.current += 1
    dispatch({ type: 'DISMISSED' })
  }, [])

  const pointAt = useCallback(
    async (point: { x: number; y: number }) => {
      // A ref rather than reducer state: the token has to be readable here, in
      // the same tick as the dispatch, and a dispatch doesn't hand back what it
      // produced.
      const token = ++lastQueryToken.current
      dispatch({ type: 'POINTER_MOVED', token })
      dispatch({ type: 'ELEMENT_RESOLVED', token, element: await query(point) })
    },
    [query],
  )

  /**
   * Commit the click at `point`.
   *
   * The outline is the confirmation, so a click takes the element the user was
   * looking at — but only while that outline is the truth. `POINTER_MOVED` keeps
   * the previous element on screen while the next answer is in flight (clearing
   * it would make the outline strobe), which means a click landing in that
   * window used to commit an element the pointer had already left. When the
   * outline is stale, the click asks about its own position instead, and the
   * answer to *that* is what gets committed.
   *
   * Either way nothing is committed for a point with nothing under it: clicking
   * background leaves picking on, rather than sending an empty passage.
   */
  const pickAt = useCallback(
    async (point: { x: number; y: number }) => {
      if (mode.kind !== 'picking') {
        return
      }
      const isOutlineCurrent = mode.token === mode.answeredToken
      // Bumped by `DISMISSED`, so a gesture the user gave up on can be
      // recognised after the await below.
      const gesture = gestureRef.current
      const element = isOutlineCurrent ? mode.element : await query(point)
      /*
       * Re-checked after the await, not just before it.
       *
       * The lookup can take as long as the guest's deadline, and Escape during
       * that window unmounts the overlay and returns this reducer to idle — but
       * this closure kept going and attached a passage for a gesture the user
       * had cancelled. The pre-await guard cannot see that, because it ran
       * before the wait.
       */
      if (!element || gesture !== gestureRef.current) {
        return
      }
      onAsk([toPickedPassage(element)])
      dispatch({ type: 'DISMISSED' })
    },
    [mode, onAsk, query],
  )

  return { mode, startPicking, dismiss, pointAt, pickAt }
}
