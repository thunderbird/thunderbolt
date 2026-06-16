/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isNewAuthUser, onSignInSuccess } from '@/components/sign-in/use-sign-in-form-state'
import { useWelcomeStore } from '@/components/welcome-dialog'
import type { AuthClient } from '@/contexts'
import { useHttpClient } from '@/contexts'
import { challengeTokenHeader, otpLength } from '@/lib/constants'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { runPostAuthBootstrap } from '@/lib/post-auth-bootstrap'
import { isValidEmailFormat } from '@/lib/utils'
import { useReducer, type FormEvent } from 'react'

type WaitlistStatus = 'idle' | 'joining' | 'checkEmail' | 'verifying' | 'error'

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
    default:
      return state
  }
}

type UseWaitlistStateOptions = {
  authClient: AuthClient
  onVerified?: () => void
}

/**
 * State hook for the unified waitlist flow.
 * Handles email submission via the waitlist API, then OTP verification for approved users.
 *
 * Privacy note: The API always returns { success: true } regardless of user status.
 * Approved users receive an OTP email; others receive waitlist status emails.
 */
export const useWaitlistState = ({ authClient, onVerified }: UseWaitlistStateOptions) => {
  const httpClient = useHttpClient()
  const analytics = useAnonymousPromotionAnalytics()
  const { data: session } = authClient.useSession()
  const [state, dispatch] = useReducer(reducer, initialState)

  const isValidEmail = isValidEmailFormat(state.email.trim())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmedEmail = state.email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) {
      return
    }

    dispatch({ type: 'START_JOINING' })

    try {
      const { challengeToken } = await httpClient
        .post('waitlist/join', { json: { email: trimmedEmail } })
        .json<{ success: boolean; challengeToken?: string }>()

      dispatch({ type: 'JOIN_SUCCESS', payload: challengeToken ?? '' })
    } catch (error) {
      console.error('Waitlist join error:', error)
      dispatch({ type: 'JOIN_ERROR', payload: 'Something went wrong. Please try again.' })
    }
  }

  const handleOtpComplete = async (value: string) => {
    if (value.length !== otpLength) {
      return
    }

    await analytics.captureAnonId(authClient)

    // Snapshot BEFORE the sign-in mutation — after it resolves, the session has flipped
    // to the new identity and `isAnonymous` no longer reflects the pre-promotion state.
    const wasAnonymous = session?.user?.isAnonymous === true

    dispatch({ type: 'START_VERIFYING' })

    try {
      const result = await authClient.signIn.emailOtp({
        email: state.email.trim(),
        otp: value,
        fetchOptions: {
          headers: { [challengeTokenHeader]: state.challengeToken },
        },
      })

      if (result.error) {
        dispatch({ type: 'VERIFY_ERROR', payload: getOtpErrorMessage(result.error, 'code') })
        return
      }

      const isNewUser = isNewAuthUser(result.data.user)
      await onSignInSuccess(isNewUser, wasAnonymous)
      analytics.onPromotionSuccess(result.data.user.id)

      // Post-auth pipeline: connect sync + resolve personal workspace + reconcile.
      // Idempotent + deduped, so the `SessionToWorkspaceBootstrap` observer firing
      // in parallel won't double-run.
      try {
        await runPostAuthBootstrap({
          kind: 'server',
          userId: result.data.user.id,
          isAnonymous: result.data.user.isAnonymous === true,
        })
      } catch (bootstrapError) {
        console.error('Post-auth bootstrap failed:', bootstrapError)
        dispatch({ type: 'VERIFY_ERROR', payload: 'Could not sync your account. Please retry.' })
        return
      }

      if (!isNewUser) {
        useWelcomeStore.getState().trigger()
      }
      onVerified?.()
    } catch (error) {
      console.error('OTP verification error:', error)
      dispatch({ type: 'VERIFY_ERROR', payload: 'Verification failed. Please try again.' })
    }
  }

  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const setOtp = (otp: string) => dispatch({ type: 'SET_OTP', payload: otp })
  const reset = () => dispatch({ type: 'RESET' })

  return {
    state,
    isValidEmail,
    actions: {
      handleSubmit,
      handleOtpComplete,
      setEmail,
      setOtp,
      reset,
    },
  }
}
