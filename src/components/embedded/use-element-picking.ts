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

import { useCallback, useEffect, useReducer, useRef } from 'react'

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
   * outline it is looking at is already out of date. `confirmable` means a tap
   * chose `element` and it is waiting on an explicit confirm.
   */
  | {
      kind: 'picking'
      element: SurfaceHighlightedElement | null
      token: number
      answeredToken: number
      confirmable: boolean
    }

type Action =
  | { type: 'PICKING_STARTED' }
  | { type: 'POINTER_MOVED'; token: number }
  | { type: 'ELEMENT_RESOLVED'; token: number; element: SurfaceHighlightedElement | null; confirmable: boolean }
  | { type: 'SELECTION_CLEARED'; token: number }
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
      return { kind: 'picking', element: null, token: 0, answeredToken: 0, confirmable: false }
    case 'POINTER_MOVED':
      // Keep the current outline while the next answer is in flight. Clearing it
      // here would make the outline strobe as the pointer moves.
      return mode.kind === 'picking' ? { ...mode, token: action.token } : mode
    case 'ELEMENT_RESOLVED':
      return mode.kind === 'picking' && mode.token === action.token
        ? {
            ...mode,
            element: action.element,
            answeredToken: action.token,
            confirmable: action.confirmable && action.element !== null,
          }
        : mode
    case 'SELECTION_CLEARED':
      return mode.kind === 'picking'
        ? { ...mode, element: null, token: action.token, answeredToken: action.token, confirmable: false }
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
  /** Changes when the surface loads a new document, which invalidates anything picked from the old one. */
  documentKey: unknown
}

export const useElementPicking = ({ query, onAsk, documentKey }: ElementPickingDeps) => {
  const [mode, dispatch] = useReducer(modeReducer, { kind: 'idle' })
  const lastQueryToken = useRef(0)
  /**
   * Identity of the live gesture. Consuming or dismissing it synchronously
   * prevents pending clicks from attaching the same passage more than once.
   */
  const gestureRef = useRef<symbol | null>(null)

  // A tapped element can wait on screen indefinitely for Add, so it has to be
  // dropped when its document goes. Stays in picking: the user is still choosing.
  const lastDocumentKey = useRef(documentKey)
  if (lastDocumentKey.current !== documentKey) {
    lastDocumentKey.current = documentKey
    dispatch({ type: 'SELECTION_CLEARED', token: ++lastQueryToken.current })
  }

  const startPicking = useCallback(() => {
    gestureRef.current = Symbol('element-pick')
    dispatch({ type: 'PICKING_STARTED' })
  }, [])
  const dismiss = useCallback(() => {
    gestureRef.current = null
    dispatch({ type: 'DISMISSED' })
  }, [])

  // Unmounting ends a pending click before it can attach to another chat.
  useEffect(
    () => () => {
      gestureRef.current = null
    },
    [],
  )

  const resolveAt = useCallback(
    async (point: { x: number; y: number }, confirmable: boolean) => {
      // A ref rather than reducer state: the token has to be readable here, in
      // the same tick as the dispatch, and a dispatch doesn't hand back what it
      // produced.
      const token = ++lastQueryToken.current
      dispatch({ type: 'POINTER_MOVED', token })
      dispatch({ type: 'ELEMENT_RESOLVED', token, element: await query(point), confirmable })
    },
    [query],
  )

  const pointAt = useCallback((point: { x: number; y: number }) => resolveAt(point, false), [resolveAt])

  /**
   * Choose the element under a tap without committing it.
   *
   * Touch has no hover, so the tap has to be the preview that hovering is on a
   * mouse, and committing needs a separate step: `confirmPick`.
   */
  const selectAt = useCallback((point: { x: number; y: number }) => resolveAt(point, true), [resolveAt])

  /**
   * Commit the tapped element. Does nothing while a newer tap is still being
   * answered, since the outline on screen is about to change.
   */
  const confirmPick = useCallback(() => {
    if (
      mode.kind !== 'picking' ||
      !mode.element ||
      !mode.confirmable ||
      mode.token !== mode.answeredToken ||
      gestureRef.current === null
    ) {
      return
    }
    dismiss()
    onAsk([toPickedPassage(mode.element)])
  }, [mode, onAsk, dismiss])

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
      if (mode.kind !== 'picking' || gestureRef.current === null) {
        return
      }
      const isOutlineCurrent = mode.token === mode.answeredToken
      // Cleared by `DISMISSED`, so a gesture the user gave up on can be
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
      dismiss()
      onAsk([toPickedPassage(element)])
    },
    [mode, onAsk, query, dismiss],
  )

  /**
   * Undo one step: a tapped element goes back to choosing, and choosing leaves
   * picking. The new token also discards any answer still in flight, so a slow
   * reply can't bring back the selection the user just cleared.
   */
  const stepBack = useCallback(() => {
    if (mode.kind === 'picking' && mode.confirmable) {
      dispatch({ type: 'SELECTION_CLEARED', token: ++lastQueryToken.current })
      return
    }
    dismiss()
  }, [mode, dismiss])

  const canConfirm = mode.kind === 'picking' && mode.confirmable

  return { mode, canConfirm, startPicking, dismiss, stepBack, pointAt, pickAt, selectAt, confirmPick }
}
