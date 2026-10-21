/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useHttpClient } from '@/contexts'
import { i18n } from '@/i18n'
import { otpLength } from '@/lib/constants'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { signInWithOtp } from '@/lib/sign-in-with-otp'
import { msg } from '@lingui/core/macro'
import { useReducer } from 'react'

const sendFailed = msg`Failed to send verification code. Please check your connection.`
const verifyFailed = msg`Verification failed. Please try again.`

export type ConfirmIdentityState = {
  status: 'idle' | 'sending' | 'sent' | 'verifying'
  otp: string
  challengeToken: string
  errorMessage: string
}

export type ConfirmIdentityAction =
  | { type: 'CODE_REQUESTED' }
  | { type: 'CODE_SENT'; payload: string }
  | { type: 'CODE_FAILED'; payload: string }
  | { type: 'OTP_CHANGED'; payload: string }
  | { type: 'VERIFY_STARTED' }
  | { type: 'VERIFY_FAILED'; payload: string }
  | { type: 'CANCELLED' }

export const initialConfirmIdentityState: ConfirmIdentityState = {
  status: 'idle',
  otp: '',
  challengeToken: '',
  errorMessage: '',
}

export const confirmIdentityReducer = (
  state: ConfirmIdentityState,
  action: ConfirmIdentityAction,
): ConfirmIdentityState => {
  switch (action.type) {
    case 'CODE_REQUESTED':
      return { ...state, status: 'sending', errorMessage: '' }
    case 'CODE_SENT':
      return { ...state, status: 'sent', otp: '', challengeToken: action.payload, errorMessage: '' }
    case 'CODE_FAILED':
      // A failed resend keeps the code screen; a failed first send stays on the prompt.
      return { ...state, status: state.status === 'sending' ? 'idle' : state.status, errorMessage: action.payload }
    case 'OTP_CHANGED':
      return { ...state, otp: action.payload, errorMessage: '' }
    case 'VERIFY_STARTED':
      return { ...state, status: 'verifying', errorMessage: '' }
    case 'VERIFY_FAILED':
      return { ...state, status: 'sent', otp: '', errorMessage: action.payload }
    case 'CANCELLED':
      return initialConfirmIdentityState
  }
}

/**
 * Re-authenticate the signed-in user with a code sent to the account's own email,
 * without signing out. Signing in again starts a new session, which counts as
 * recent. The email can't be changed, so the new session is always for the same
 * account and the device keeps its keys and data.
 */
export const useConfirmIdentityState = ({ onConfirmed }: { onConfirmed: () => void }) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { data: session } = authClient.useSession()
  const email = session?.user.email ?? ''
  const [state, dispatch] = useReducer(confirmIdentityReducer, initialConfirmIdentityState)

  const requestCode = async (): Promise<boolean> => {
    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email } })
        .json<{ challengeToken?: string }>()
      dispatch({ type: 'CODE_SENT', payload: challengeToken ?? '' })
      return true
    } catch (error) {
      console.error('Failed to send the confirmation code:', error)
      dispatch({ type: 'CODE_FAILED', payload: i18n._(sendFailed) })
      return false
    }
  }

  const sendCode = async () => {
    dispatch({ type: 'CODE_REQUESTED' })
    await requestCode()
  }

  const verify = async (otp: string) => {
    if (otp.length !== otpLength) {
      return
    }
    dispatch({ type: 'VERIFY_STARTED' })
    try {
      const result = await signInWithOtp(authClient, { email, otp, challengeToken: state.challengeToken })
      if (result.error) {
        dispatch({ type: 'VERIFY_FAILED', payload: i18n._(getOtpErrorMessage(result.error, 'code')) })
        return
      }
      onConfirmed()
    } catch (error) {
      console.error('Confirming identity failed:', error)
      dispatch({ type: 'VERIFY_FAILED', payload: i18n._(verifyFailed) })
    }
  }

  return {
    email,
    state,
    actions: {
      sendCode,
      resend: requestCode,
      setOtp: (otp: string) => dispatch({ type: 'OTP_CHANGED', payload: otp }),
      verify,
      cancel: () => dispatch({ type: 'CANCELLED' }),
    },
  }
}
