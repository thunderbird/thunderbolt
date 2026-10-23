/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'

type State = { open: boolean; instructions: string; failed: boolean }
type Action =
  | { type: 'openChanged'; open: boolean }
  | { type: 'instructionsChanged'; value: string }
  | { type: 'compactionFailed' }
  | { type: 'compactionStarted' }
  | { type: 'compactionSucceeded' }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'openChanged':
      return { ...state, open: action.open, failed: false }
    case 'instructionsChanged':
      return { ...state, instructions: action.value }
    case 'compactionFailed':
      return { ...state, failed: true }
    case 'compactionStarted':
      return { ...state, failed: false }
    case 'compactionSucceeded':
      return { ...state, open: false, failed: false }
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
    dispatch({ type: 'compactionStarted' })
    startTransition(async () => {
      try {
        await onCompact(state.instructions.trim() || undefined)
        dispatch({ type: 'compactionSucceeded' })
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Context compaction failed', error)
          dispatch({ type: 'compactionFailed' })
        }
      }
    })
  }
  return {
    ...state,
    pending,
    compact,
    setOpen: (open: boolean) => dispatch({ type: 'openChanged', open }),
    setInstructions: (value: string) => dispatch({ type: 'instructionsChanged', value }),
  }
}
