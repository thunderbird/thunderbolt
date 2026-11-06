/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isNewAuthUser } from '@/lib/returning-user-onboarding'
import { signInWithOtp } from '@/lib/sign-in-with-otp'
import { useWelcomeStore } from '@/components/welcome-dialog'
import type { AuthClient } from '@/contexts'
import { useHttpClient } from '@/contexts'
import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import { otpLength } from '@/lib/constants'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { isPasskeyCancellation, signInWithPasskey } from '@/lib/passkey'
import { isValidEmailFormat } from '@/lib/utils'
import { useReducer, type FormEvent } from 'react'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'

const joinFailed = msg`Something went wrong. Please try again.`
const verifyFailed = msg`Verification failed. Please try again.`
const passkeyFailed = msg`Couldn't sign in with your passkey. Please try again or use your email.`

type WaitlistStatus = 'idle' | 'joining' | 'checkEmail' | 'verifying' | 'passkey' | 'error'

type State = {
  email: string
  otp: string
  challengeToken: string
  status: WaitlistStatus
  errorMessage: string
}

type Action =
  | { type: 'SET_EMAIL'; payload: string }
  | { type: 'SET_OTP'; payload: string }
  | { type: 'START_JOINING' }
  | { type: 'JOIN_SUCCESS'; payload: string }
  | { type: 'JOIN_ERROR'; payload: string }
  | { type: 'START_VERIFYING' }
  | { type: 'VERIFY_ERROR'; payload: string }
  | { type: 'RESET' }
  | { type: 'PASSKEY_START' }
  | { type: 'PASSKEY_ERROR'; payload: string }
  | { type: 'PASSKEY_CANCEL' }

const initialState: State = {
  email: '',
  otp: '',
  challengeToken: '',
  status: 'idle',
  errorMessage: '',
}

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'SET_EMAIL':
      return { ...state, email: action.payload, errorMessage: '' }
    case 'SET_OTP':
      return { ...state, otp: action.payload }
    case 'START_JOINING':
      return { ...state, status: 'joining', errorMessage: '' }
    case 'JOIN_SUCCESS':
      return { ...state, status: 'checkEmail', challengeToken: action.payload }
    case 'JOIN_ERROR':
      return { ...state, status: 'error', errorMessage: action.payload }
    case 'START_VERIFYING':
      return { ...state, status: 'verifying', errorMessage: '' }
    case 'VERIFY_ERROR':
      return { ...state, status: 'checkEmail', otp: '', errorMessage: action.payload }
    case 'RESET':
      return initialState
    case 'PASSKEY_START':
      return { ...state, status: 'passkey', errorMessage: '' }
    case 'PASSKEY_ERROR':
      return { ...state, status: 'error', errorMessage: action.payload }
    case 'PASSKEY_CANCEL':
      return { ...state, status: 'idle', errorMessage: '' }
    default:
      return state
  }
}

type UseWaitlistStateOptions = {
  authClient: AuthClient
}

/**
 * State hook for the unified waitlist flow.
 * Handles email submission via the waitlist API, then OTP verification for approved users.
 * AuthGate owns the signed-in redirect; post-sign-in work can finish after this page unmounts.
 *
 * Privacy note: The API always returns { success: true } regardless of user status.
 * Approved users receive an OTP email; others receive waitlist status emails.
 */
export const useWaitlistState = ({ authClient }: UseWaitlistStateOptions) => {
  const httpClient = useHttpClient()
  const analytics = useAnonymousPromotionAnalytics()
  const [state, dispatch] = useReducer(reducer, initialState)
  const operation = useAsyncAttempt()

  const isValidEmail = isValidEmailFormat(state.email.trim())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmedEmail = state.email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) {
      return
    }

    const attempt = operation.begin()
    if (!attempt) {
      return
    }
    dispatch({ type: 'START_JOINING' })

    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email: trimmedEmail } })
        .json<{ success: boolean; challengeToken?: string }>()

      if (attempt.isCurrent()) {
        dispatch({ type: 'JOIN_SUCCESS', payload: challengeToken ?? '' })
      }
    } catch (error) {
      console.error('Waitlist join error:', error)
      if (attempt.isCurrent()) {
        dispatch({ type: 'JOIN_ERROR', payload: i18n._(joinFailed) })
      }
    } finally {
      attempt.finish()
    }
  }

  const handleOtpComplete = async (value: string) => {
    if (value.length !== otpLength) {
      return
    }

    const attempt = operation.begin()
    if (!attempt) {
      return
    }
    dispatch({ type: 'START_VERIFYING' })

    try {
      await analytics.captureAnonId(authClient)
      if (!attempt.isCurrent()) {
        return
      }
      const result = await signInWithOtp(authClient, {
        email: state.email.trim(),
        otp: value,
        challengeToken: state.challengeToken,
      })

      if (result.error) {
        if (attempt.isCurrent()) {
          dispatch({ type: 'VERIFY_ERROR', payload: i18n._(getOtpErrorMessage(result.error, 'code')) })
        }
        return
      }

      const isNewUser = isNewAuthUser(result.data.user)
      analytics.onPromotionSuccess(result.data.user.id)

      if (!isNewUser) {
        useWelcomeStore.getState().trigger()
      }
    } catch (error) {
      console.error('OTP verification error:', error)
      if (attempt.isCurrent()) {
        dispatch({ type: 'VERIFY_ERROR', payload: i18n._(verifyFailed) })
      }
    } finally {
      attempt.finish()
    }
  }

  const handlePasskeySignIn = async () => {
    const attempt = operation.begin()
    if (!attempt) {
      return
    }
    dispatch({ type: 'PASSKEY_START' })

    try {
      await analytics.captureAnonId(authClient)
      if (!attempt.isCurrent()) {
        return
      }
      const { userId } = await signInWithPasskey(authClient)

      analytics.onPromotionSuccess(userId)

      useWelcomeStore.getState().trigger()
    } catch (error) {
      if (isPasskeyCancellation(error)) {
        if (attempt.isCurrent()) {
          dispatch({ type: 'PASSKEY_CANCEL' })
        }
        return
      }
      console.error('Passkey sign-in error:', error)
      if (attempt.isCurrent()) {
        dispatch({ type: 'PASSKEY_ERROR', payload: i18n._(passkeyFailed) })
      }
    } finally {
      attempt.finish()
    }
  }

  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const setOtp = (otp: string) => dispatch({ type: 'SET_OTP', payload: otp })
  const reset = () => {
    operation.cancel()
    dispatch({ type: 'RESET' })
  }

  return {
    state: { ...state, passkeyPending: state.status === 'passkey' },
    isValidEmail,
    actions: {
      handleSubmit,
      handleOtpComplete,
      handlePasskeySignIn,
      setEmail,
      setOtp,
      reset,
    },
  }
}
