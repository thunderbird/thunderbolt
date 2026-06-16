/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { challengeTokenHeader, otpLength } from '@/lib/constants'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { HttpError, type HttpClient } from '@/lib/http'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { updateSettings } from '@/dal'
import { getDb, getDatabaseInstance } from '@/db/database'
import { runPostAuthBootstrap } from '@/lib/post-auth-bootstrap'
import { isValidEmailFormat } from '@/lib/utils'
import { useReducer, type FormEvent } from 'react'

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

/** Better Auth includes `isNew` on the user object at runtime but not in its types. */
export const isNewAuthUser = (user: unknown): boolean =>
  typeof user === 'object' && user !== null && 'isNew' in user && (user as { isNew: unknown }).isNew === true

type OnSignInSuccessDeps = {
  getDatabase?: typeof getDatabaseInstance
  getDrizzle?: typeof getDb
}

/**
 * Sync is disabled by default after sign-in/sign-up; user can enable it in Preferences.
 * For returning non-anonymous users only: reset pending CRUD operations so that when they
 * later enable sync, local ops do not conflict with cloud data.
 *
 * `wasAnonymous` short-circuits this for the anonymous → real-account promotion case —
 * the queued PUTs in `ps_crud` are exactly the anon-session writes we WANT to upload
 * under the new identity. Wiping them here would silently destroy the user's anon-session
 * work.
 */
export const onSignInSuccess = async (
  isNewUser: boolean,
  wasAnonymous: boolean,
  deps: OnSignInSuccessDeps = {},
): Promise<void> => {
  if (isNewUser || wasAnonymous) {
    return
  }

  const { getDatabase = getDatabaseInstance, getDrizzle = getDb } = deps

  // Error containment: failures in post-auth housekeeping must NOT propagate to the caller's
  // sign-in handler, which translates any throw into a "verification failed" UI even though
  // the OTP was already consumed and the user is authenticated. Log and swallow here.
  try {
    const database = getDatabase()
    if ('clearPendingCrudOperations' in database) {
      // on sign in (existing user), set user_has_completed_onboarding to true
      // we consider that an existing user has completed onboarding since they have signed in previously
      // this is necessary because sync is disabled by default - so we don't have a way to know if they have actually completed onboarding
      const db = getDrizzle()
      await updateSettings(db, { user_has_completed_onboarding: true })
      await (database as { clearPendingCrudOperations: () => Promise<void> }).clearPendingCrudOperations()
    }
  } catch (error) {
    console.error('Failed to clear pending CRUD after sign-in:', error)
  }
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
  const { data: session } = authClient.useSession()
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
      const message = await getServerErrorMessage(
        error,
        'Failed to send verification code. Please check your connection.',
      )
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

      const isNewUser = isNewAuthUser(result.data?.user)
      await onSignInSuccess(isNewUser, wasAnonymous)
      if (result.data?.user?.id) {
        analytics.onPromotionSuccess(result.data.user.id)
      }

      // Post-auth pipeline: connect sync, await the personal workspace, reconcile
      // defaults. Fires here so the success step doesn't appear until the user can
      // actually use the app. The dedupe in `runPostAuthBootstrap` keeps this
      // safe even if `SessionToWorkspaceBootstrap` is firing in parallel.
      if (result.data?.user?.id) {
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
      }

      // Sign-in successful - show success state
      dispatch({ type: 'VERIFY_SUCCESS' })
    } catch (error) {
      console.error('OTP verification error:', error)
      dispatch({ type: 'VERIFY_ERROR', payload: 'Verification failed. Please try again.' })
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
      const message = await getServerErrorMessage(
        error,
        'Failed to resend verification code. Please check your connection.',
      )
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
