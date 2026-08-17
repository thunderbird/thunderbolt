/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useHttpClient, type HttpClient } from '@/contexts'
import { rotateAK, RotationStaleError } from '@/services/encryption'

type ChangeRecoveryKeyState = {
  /** idle → confirming (dialog open) → display (new phrase shown) → idle */
  status: 'idle' | 'confirming' | 'display'
  isRotating: boolean
  newRecoveryKey: string | null
  error: string | null
}

type ChangeRecoveryKeyAction =
  | { type: 'OPEN_CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'START_ROTATION' }
  | { type: 'ROTATION_SUCCESS'; payload: string }
  | { type: 'ROTATION_FAILED'; payload: string }
  | { type: 'DONE' }

export const initialState: ChangeRecoveryKeyState = {
  status: 'idle',
  isRotating: false,
  newRecoveryKey: null,
  error: null,
}

export const reducer = (state: ChangeRecoveryKeyState, action: ChangeRecoveryKeyAction): ChangeRecoveryKeyState => {
  switch (action.type) {
    case 'OPEN_CONFIRM':
      return { ...initialState, status: 'confirming' }
    case 'CANCEL':
      return initialState
    case 'START_ROTATION':
      return { ...state, isRotating: true, error: null }
    case 'ROTATION_SUCCESS':
      return { status: 'display', isRotating: false, newRecoveryKey: action.payload, error: null }
    // Stay on the confirm dialog so its action button doubles as the retry
    // affordance (RotationStaleError is retryable by design).
    case 'ROTATION_FAILED':
      return { ...state, isRotating: false, error: action.payload }
    case 'DONE':
      return initialState
    default:
      return state
  }
}

/**
 * State machine for the "Change recovery phrase" settings action: confirm →
 * rotate the Account Key (`rotateAK`) → display the NEW 24-word phrase behind
 * the saved-it confirmation gate. `rotate` is a dependency seam for tests.
 */
export const useChangeRecoveryKey = (rotate: (httpClient: HttpClient) => Promise<string> = rotateAK) => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  const openConfirm = () => dispatch({ type: 'OPEN_CONFIRM' })
  const cancel = () => dispatch({ type: 'CANCEL' })
  const done = () => dispatch({ type: 'DONE' })

  const confirmRotation = async () => {
    dispatch({ type: 'START_ROTATION' })
    try {
      const newRecoveryKey = await rotate(httpClient)
      dispatch({ type: 'ROTATION_SUCCESS', payload: newRecoveryKey })
    } catch (err) {
      if (err instanceof RotationStaleError) {
        dispatch({
          type: 'ROTATION_FAILED',
          payload: 'Your account keys changed while preparing the new phrase. Please try again.',
        })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to change the recovery phrase'
      dispatch({ type: 'ROTATION_FAILED', payload: message })
    }
  }

  return {
    ...state,
    openConfirm,
    cancel,
    confirmRotation,
    done,
  }
}
