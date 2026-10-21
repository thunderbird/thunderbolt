/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'

type State = { open: boolean; instructions: string; failed: boolean }
type Action =
  | { type: 'open'; open: boolean }
  | { type: 'instructions'; value: string }
  | { type: 'failed' }
  | { type: 'start' }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'open':
      return { ...state, open: action.open, failed: false }
    case 'instructions':
      return { ...state, instructions: action.value }
    case 'failed':
      return { ...state, failed: true }
    case 'start':
      return { ...state, failed: false }
  }
}

/** Keep prompt edits and retryable failures local to the context menu. */
export const useContextUsageState = (onCompact?: (instructions?: string) => Promise<void>) => {
  const [state, dispatch] = useReducer(reducer, { open: false, instructions: '', failed: false })
  const [pending, startTransition] = useTransition()
  const compact = () => {
    if (!onCompact || pending) {
      return
    }
    dispatch({ type: 'start' })
    startTransition(async () => {
      try {
        await onCompact(state.instructions.trim() || undefined)
        dispatch({ type: 'open', open: false })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Context compaction failed', error)
          dispatch({ type: 'failed' })
        }
      }
    })
  }
  return {
    ...state,
    pending,
    compact,
    setOpen: (open: boolean) => dispatch({ type: 'open', open }),
    setInstructions: (value: string) => dispatch({ type: 'instructions', value }),
  }
}
