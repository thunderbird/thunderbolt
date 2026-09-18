/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useHttpClient, type HttpClient } from '@/contexts'
import { postStepUpRequest } from '@/api/encryption'
import { changeRecoveryPhrase, RotationStaleError, StepUpVerificationError } from '@/services/encryption'

type ChangeRecoveryKeyState = {
  /** idle → confirming (dialog open) → stepUp (emailed code entry) → display (new phrase shown) → idle */
  status: 'idle' | 'confirming' | 'stepUp' | 'display'
  /** Covers both the code request and the rotation — whichever is in flight. */
  isBusy: boolean
  otp: string
  newRecoveryKey: string | null
  error: string | null
}

type ChangeRecoveryKeyAction =
  | { type: 'OPEN_CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'START_REQUEST' }
  | { type: 'CODE_SENT' }
  | { type: 'REQUEST_FAILED'; payload: string }
  | { type: 'OTP_CHANGED'; payload: string }
  | { type: 'START_ROTATION' }
  | { type: 'ROTATION_SUCCESS'; payload: string }
  | { type: 'ROTATION_FAILED'; payload: string }
  | { type: 'CODE_REJECTED'; payload: string }
  | { type: 'DONE' }

export const initialState: ChangeRecoveryKeyState = {
  status: 'idle',
  isBusy: false,
  otp: '',
  newRecoveryKey: null,
  error: null,
}

export const reducer = (state: ChangeRecoveryKeyState, action: ChangeRecoveryKeyAction): ChangeRecoveryKeyState => {
  switch (action.type) {
    case 'OPEN_CONFIRM':
      return { ...initialState, status: 'confirming' }
    case 'CANCEL':
      return initialState
    case 'START_REQUEST':
    case 'START_ROTATION':
      return { ...state, isBusy: true, error: null }
    case 'CODE_SENT':
      return { ...state, status: 'stepUp', isBusy: false, otp: '', error: null }
    // Stay on the current dialog so its action button doubles as the retry
    // affordance (the code request and RotationStaleError are both retryable).
    case 'REQUEST_FAILED':
    case 'ROTATION_FAILED':
      return { ...state, isBusy: false, error: action.payload }
    // Wrong/expired code: clear it so the input is ready for a fresh attempt.
    case 'CODE_REJECTED':
      return { ...state, isBusy: false, otp: '', error: action.payload }
    case 'OTP_CHANGED':
      return { ...state, otp: action.payload }
    case 'ROTATION_SUCCESS':
      return { ...initialState, status: 'display', newRecoveryKey: action.payload }
    case 'DONE':
      return initialState
    default:
      return state
  }
}

/** Backend `emailOTP` config mints 8-digit codes. */
export const stepUpOtpLength = 8

/**
 * State machine for the "Change recovery phrase" settings action (THU-875):
 * confirm → request the emailed step-up code → enter it → rotate the Account
 * Key and re-anchor the recovery slot to a freshly minted phrase
 * (`changeRecoveryPhrase`, with the code riding the rotate request) → display
 * the NEW 24-word phrase behind the saved-it confirmation gate. `rotate` and
 * `requestCode` are dependency seams for tests.
 */
export const useChangeRecoveryKey = (
  rotate: (httpClient: HttpClient, opts: { stepUpOtp: string }) => Promise<string> = changeRecoveryPhrase,
  requestCode: (httpClient: HttpClient) => Promise<void> = postStepUpRequest,
) => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  const openConfirm = () => dispatch({ type: 'OPEN_CONFIRM' })
  const cancel = () => dispatch({ type: 'CANCEL' })
  const done = () => dispatch({ type: 'DONE' })
  const setOtp = (otp: string) => dispatch({ type: 'OTP_CHANGED', payload: otp })

  /** Confirm step → email the code and advance to code entry. Also the Resend handler. */
  const requestStepUpCode = async () => {
    dispatch({ type: 'START_REQUEST' })
    try {
      await requestCode(httpClient)
      dispatch({ type: 'CODE_SENT' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send the verification code'
      dispatch({ type: 'REQUEST_FAILED', payload: message })
    }
  }

  const confirmRotation = async () => {
    dispatch({ type: 'START_ROTATION' })
    try {
      const newRecoveryKey = await rotate(httpClient, { stepUpOtp: state.otp })
      dispatch({ type: 'ROTATION_SUCCESS', payload: newRecoveryKey })
    } catch (err) {
      if (err instanceof StepUpVerificationError) {
        dispatch({ type: 'CODE_REJECTED', payload: 'That code is invalid or expired. Check your email and try again.' })
        return
      }
      if (err instanceof RotationStaleError) {
        // The code was NOT consumed (that happens only on a committed
        // rotation), so retrying with the same one is fine.
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
    setOtp,
    requestStepUpCode,
    confirmRotation,
    done,
  }
}
