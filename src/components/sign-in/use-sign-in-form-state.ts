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
import { isPasskeyCancellation, signInWithPasskey } from '@/lib/passkey'
import { isValidEmailFormat } from '@/lib/utils'
import { useAuthAttempt } from '@/hooks/use-auth-attempt'
import { useReducer, type FormEvent } from 'react'

const sendFailed = msg`Failed to send verification code. Please check your connection.`
const resendFailed = msg`Failed to resend verification code. Please check your connection.`
const verifyFailed = msg`Verification failed. Please try again.`
const passkeyFailed = msg`Couldn't sign in with your passkey. Please try again or use your email.`

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

type FormStatus =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'resending'
  | 'verifying'
  | 'completing'
  | 'success'
  | 'error'
  | 'passkey'

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
  | { type: 'START_SENDING'; resend: boolean }
  | { type: 'SEND_SUCCESS'; payload: string }
  | { type: 'SEND_ERROR'; payload: string; resend: boolean }
  | { type: 'START_VERIFYING' }
  | { type: 'AUTHENTICATED' }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'VERIFY_ERROR'; payload: string }
  | { type: 'RESET' }
  | { type: 'GO_BACK' }
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
      return { ...state, email: action.payload }
    case 'SET_OTP':
      return { ...state, otp: action.payload }
    case 'START_SENDING':
      return { ...state, status: action.resend ? 'resending' : 'sending', otp: '', errorMessage: '' }
    case 'SEND_SUCCESS':
      return { ...state, status: 'sent', challengeToken: action.payload, otp: '', errorMessage: '' }
    case 'SEND_ERROR':
      return { ...state, status: action.resend ? 'sent' : 'error', errorMessage: action.payload }
    case 'START_VERIFYING':
      return { ...state, status: 'verifying', errorMessage: '' }
    case 'AUTHENTICATED':
      return { ...state, status: 'completing', errorMessage: '' }
    case 'VERIFY_SUCCESS':
      return { ...state, status: 'success' }
    case 'VERIFY_ERROR':
      return { ...state, status: 'sent', otp: '', errorMessage: action.payload }
    case 'RESET':
      return initialState
    case 'GO_BACK':
      return { ...state, status: 'idle', otp: '', errorMessage: '' }
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

type UseSignInFormStateOptions = {
  authClient: AuthClient
  httpClient: HttpClient
  onCancel?: () => void
  onEmailSent?: () => void
  /** Pre-fill the email input (user still needs to click submit) */
  initialEmail?: string
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
}: UseSignInFormStateOptions) => {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    email: initialEmail ?? '',
  })

  const operation = useAuthAttempt()
  const analytics = useAnonymousPromotionAnalytics()
  const isValidEmail = isValidEmailFormat(state.email.trim())

  const sendCode = async (resend: boolean): Promise<boolean> => {
    const email = state.email.trim()
    if (!isValidEmailFormat(email)) {
      return false
    }
    const attempt = operation.begin()
    if (!attempt) {
      return false
    }
    dispatch({ type: 'START_SENDING', resend })
    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email }, signal: attempt.signal })
        .json<{ success: boolean; challengeToken?: string }>()
      if (!attempt.isCurrent()) {
        return false
      }
      dispatch({ type: 'SEND_SUCCESS', payload: challengeToken ?? '' })
      if (!resend) {
        onEmailSent?.()
      }
      return true
    } catch (error) {
      if (!attempt.isCancellation(error)) {
        console.error('Failed to send verification OTP:', error)
      }
      const message = await getServerErrorMessage(error, i18n._(resend ? resendFailed : sendFailed))
      if (attempt.isCurrent()) {
        dispatch({ type: 'SEND_ERROR', payload: message, resend })
      }
      attempt.finish('failed')
      return false
    } finally {
      attempt.finish()
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    await sendCode(false)
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
        signal: attempt.signal,
        onAuthenticated: () => {
          attempt.commit()
          if (attempt.isCurrent()) {
            dispatch({ type: 'AUTHENTICATED' })
          }
        },
      })
      if (!attempt.isCurrent()) {
        return
      }
      if (result.error) {
        dispatch({ type: 'VERIFY_ERROR', payload: i18n._(getOtpErrorMessage(result.error, 'code')) })
        return
      }
      if (result.data?.user?.id) {
        analytics.onPromotionSuccess(result.data.user.id)
      }
      dispatch({ type: 'VERIFY_SUCCESS' })
    } catch (error) {
      if (!attempt.isCancellation(error)) {
        console.error('OTP verification error:', error)
      }
      if (attempt.isCurrent()) {
        dispatch({ type: 'VERIFY_ERROR', payload: i18n._(verifyFailed) })
      }
      attempt.finish('failed')
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
      const { userId } = await signInWithPasskey(authClient, {
        signal: attempt.signal,
        onAuthenticated: () => {
          attempt.commit()
          if (attempt.isCurrent()) {
            dispatch({ type: 'AUTHENTICATED' })
          }
        },
      })
      if (!attempt.isCurrent()) {
        return
      }
      analytics.onPromotionSuccess(userId)
      dispatch({ type: 'VERIFY_SUCCESS' })
    } catch (error) {
      const cancelled = !attempt.isCommitted() && (isPasskeyCancellation(error) || attempt.isCancellation(error))
      if (!cancelled) {
        console.error('Passkey sign-in error:', error)
      }
      if (attempt.isCurrent()) {
        dispatch(cancelled ? { type: 'PASSKEY_CANCEL' } : { type: 'PASSKEY_ERROR', payload: i18n._(passkeyFailed) })
      }
      attempt.finish('failed')
    } finally {
      attempt.finish()
    }
  }

  const handleCancel = () => {
    if (!operation.cancel()) {
      return
    }
    dispatch({ type: 'RESET' })
    onCancel?.()
  }
  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const setOtp = (otp: string) => dispatch({ type: 'SET_OTP', payload: otp })
  const goBack = () => {
    if (!operation.cancel()) {
      return false
    }
    dispatch({ type: 'GO_BACK' })
    return true
  }
  const handleResend = () => sendCode(true)

  return {
    state: { ...state, passkeyPending: state.status === 'passkey' },
    isValidEmail,
    actions: {
      handleSubmit,
      handleOtpComplete,
      handlePasskeySignIn,
      handleCancel,
      handleResend,
      goBack,
      setEmail,
      setOtp,
    },
  }
}

export type { FormStatus, State as SignInFormState }
