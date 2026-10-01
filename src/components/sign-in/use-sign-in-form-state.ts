/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { signInWithOtp } from '@/lib/sign-in-with-otp'
import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import { otpLength } from '@/lib/constants'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { HttpError, type HttpClient } from '@/lib/http'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { isValidEmailFormat } from '@/lib/utils'
import { useReducer, type FormEvent } from 'react'

const sendFailed = msg`Failed to send verification code. Please check your connection.`
const resendFailed = msg`Failed to resend verification code. Please check your connection.`
const verifyFailed = msg`Verification failed. Please try again.`

/** Extract a user-facing error message from an HttpError response body, or return the fallback. */
const getServerErrorMessage = async (error: unknown, fallback: string): Promise<string> => {
  if (!(error instanceof HttpError)) {
    return fallback
  }
  try {
    const body = await error.response.json()
    if (typeof body?.message === 'string' && body.message) {
      return body.message
    }
  } catch (e) {
    console.info('Could not parse error response body as JSON:', e)
  }
  return fallback
}

type FormStatus = 'idle' | 'sending' | 'sent' | 'verifying' | 'success' | 'error'

type State = {
  email: string
  otp: string
  challengeToken: string
  status: FormStatus
  errorMessage: string
}

type Action =
  | { type: 'SET_EMAIL'; payload: string }
  | { type: 'SET_OTP'; payload: string }
  | { type: 'START_SENDING' }
  | { type: 'SEND_SUCCESS'; payload: string }
  | { type: 'SEND_ERROR'; payload: string }
  | { type: 'START_VERIFYING' }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'VERIFY_ERROR'; payload: string }
  | { type: 'RESET' }
  | { type: 'GO_BACK' }
  | { type: 'SET_ERROR'; payload: string }

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
      return { ...state, email: action.payload }
    case 'SET_OTP':
      return { ...state, otp: action.payload }
    case 'START_SENDING':
      return { ...state, status: 'sending', errorMessage: '' }
    case 'SEND_SUCCESS':
      return { ...state, status: 'sent', challengeToken: action.payload, otp: '', errorMessage: '' }
    case 'SEND_ERROR':
      return { ...state, status: 'error', errorMessage: action.payload }
    case 'START_VERIFYING':
      return { ...state, status: 'verifying', errorMessage: '' }
    case 'VERIFY_SUCCESS':
      return { ...state, status: 'success' }
    case 'VERIFY_ERROR':
      return { ...state, status: 'sent', otp: '', errorMessage: action.payload }
    case 'RESET':
      return initialState
    case 'GO_BACK':
      return { ...state, status: 'idle', otp: '', errorMessage: '' }
    case 'SET_ERROR':
      return { ...state, errorMessage: action.payload }
    default:
      return state
  }
}

type UseSignInFormStateOptions = {
  authClient: AuthClient
  httpClient: HttpClient
  onCancel?: () => void
  onEmailSent?: () => void
  /** Pre-fill the email input (user still needs to click submit) */
  initialEmail?: string
  /** Initialize directly in OTP step (OTP must already be sent before mounting) */
  skipToOtp?: boolean
  /** Challenge token to use when skipToOtp is true (required for OTP verification) */
  initialChallengeToken?: string
}

/**
 * State hook for SignInModal
 * Separates computation/logic from display for easier testing
 */
export const useSignInFormState = ({
  authClient,
  httpClient,
  onCancel,
  onEmailSent,
  initialEmail,
  skipToOtp,
  initialChallengeToken,
}: UseSignInFormStateOptions) => {
  // If skipToOtp is requested without an email, fall back to idle state instead of crashing
  const canSkipToOtp = skipToOtp && !!initialEmail?.trim()

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    email: initialEmail ?? '',
    status: canSkipToOtp ? 'sent' : 'idle',
    challengeToken: canSkipToOtp ? (initialChallengeToken ?? '') : '',
  })

  const analytics = useAnonymousPromotionAnalytics()
  const isValidEmail = isValidEmailFormat(state.email.trim())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmedEmail = state.email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) {
      return
    }

    dispatch({ type: 'START_SENDING' })

    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email: trimmedEmail } })
        .json<{ success: boolean; challengeToken?: string }>()

      dispatch({ type: 'SEND_SUCCESS', payload: challengeToken ?? '' })
    } catch (error) {
      console.error('Failed to send verification OTP:', error)
      const message = await getServerErrorMessage(error, i18n._(sendFailed))
      dispatch({ type: 'SEND_ERROR', payload: message })
      return
    }

    onEmailSent?.()
  }

  const handleOtpComplete = async (value: string) => {
    if (value.length !== otpLength) {
      return
    }

    await analytics.captureAnonId(authClient)

    dispatch({ type: 'START_VERIFYING' })

    try {
      // `state.challengeToken` is always a string, so the header is always sent
      // — including empty, as before.
      const result = await signInWithOtp(authClient, {
        email: state.email.trim(),
        otp: value,
        challengeToken: state.challengeToken,
      })

      if (result.error) {
        dispatch({ type: 'VERIFY_ERROR', payload: i18n._(getOtpErrorMessage(result.error, 'code')) })
        return
      }

      if (result.data?.user?.id) {
        analytics.onPromotionSuccess(result.data.user.id)
      }

      // Sign-in successful - show success state
      dispatch({ type: 'VERIFY_SUCCESS' })
    } catch (error) {
      console.error('OTP verification error:', error)
      dispatch({ type: 'VERIFY_ERROR', payload: i18n._(verifyFailed) })
    }
  }

  const handleCancel = () => {
    dispatch({ type: 'RESET' })
    onCancel?.()
  }

  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const setOtp = (otp: string) => dispatch({ type: 'SET_OTP', payload: otp })
  const goBack = () => dispatch({ type: 'GO_BACK' })

  /** Resends the verification email. Returns true on success, false on failure. */
  const handleResend = async (): Promise<boolean> => {
    const trimmedEmail = state.email.trim()
    if (!trimmedEmail) {
      return false
    }

    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email: trimmedEmail } })
        .json<{ success: boolean; challengeToken?: string }>()

      dispatch({ type: 'SEND_SUCCESS', payload: challengeToken ?? '' })
      return true
    } catch (error) {
      console.error('Failed to resend verification OTP:', error)
      const message = await getServerErrorMessage(error, i18n._(resendFailed))
      dispatch({ type: 'SET_ERROR', payload: message })
      return false
    }
  }

  return {
    state,
    isValidEmail,
    actions: {
      handleSubmit,
      handleOtpComplete,
      handleCancel,
      handleResend,
      goBack,
      setEmail,
      setOtp,
    },
  }
}

export type { FormStatus, State as SignInFormState }
