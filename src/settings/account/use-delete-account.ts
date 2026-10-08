/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { msg } from '@lingui/core/macro'
import { deleteAccount, postAccountDeletionCode } from '@/api/account'
import { useHttpClient, type HttpClient } from '@/contexts'
import { i18n } from '@/i18n'
import { clearLocalData } from '@/lib/cleanup'
import { HttpError } from '@/lib/http'
import { StepUpVerificationError } from '@/lib/step-up'

// `msg` at module scope, resolved with `i18n._` in the handlers: a module-scope
// `t` would freeze these to the boot locale.
const codeRequestFailed = msg`Failed to send the verification code`
const codeRequestThrottled = msg`A code was just sent. Wait a moment and try again.`
const codeRejected = msg`That code is invalid or expired. Check your email and try again.`
// Reuses the pre-extraction wording on purpose — it is translated in every
// locale, and rewording it would orphan those translations.
const deleteFailed = msg`Failed to delete account.`

type DeleteAccountState = {
  /** idle → confirming (are-you-sure) → stepUp (emailed code entry); success ends in a reload. */
  status: 'idle' | 'confirming' | 'stepUp'
  /** Covers the code request and the deletion — whichever is in flight. */
  isBusy: boolean
  otp: string
  error: string | null
}

type DeleteAccountAction =
  | { type: 'OPEN_CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'START_REQUEST' }
  | { type: 'CODE_SENT' }
  | { type: 'REQUEST_FAILED'; payload: string }
  | { type: 'OTP_CHANGED'; payload: string }
  | { type: 'START_DELETE' }
  | { type: 'DELETE_FAILED'; payload: string }
  | { type: 'CODE_REJECTED'; payload: string }

export const initialState: DeleteAccountState = { status: 'idle', isBusy: false, otp: '', error: null }

export const reducer = (state: DeleteAccountState, action: DeleteAccountAction): DeleteAccountState => {
  switch (action.type) {
    case 'OPEN_CONFIRM':
      return { ...initialState, status: 'confirming' }
    case 'CANCEL':
      return initialState
    case 'START_REQUEST':
    case 'START_DELETE':
      return { ...state, isBusy: true, error: null }
    case 'CODE_SENT':
      // Ignored unless we are still on the confirm step: cancelling mid-request
      // must not pop the code dialog open when the response lands.
      return state.status === 'confirming' ? { ...state, status: 'stepUp', isBusy: false, otp: '', error: null } : state
    case 'REQUEST_FAILED':
      // Back to idle, unlike the recovery-phrase flow which stays on its
      // confirm step. `ConfirmActionDialog` has no error slot, so the section's
      // alert shows the failure and its button is the retry.
      return { ...initialState, error: action.payload }
    case 'DELETE_FAILED':
      // Stay on code entry and keep the code — it is only burned on success.
      return { ...state, isBusy: false, error: action.payload }
    case 'CODE_REJECTED':
      return { ...state, isBusy: false, otp: '', error: action.payload }
    case 'OTP_CHANGED':
      return { ...state, otp: action.payload }
  }
}

/** Wipe this device and restart, so no deleted-account state survives in memory. */
const reloadAfterDeletion = async () => {
  await clearLocalData()
  window.location.reload()
}

/** Translate at the display boundary — an `HttpError` message is English. */
const requestErrorMessage = (err: unknown): string =>
  err instanceof HttpError && err.response.status === 429 ? i18n._(codeRequestThrottled) : i18n._(codeRequestFailed)

/**
 * Account deletion, gated by an emailed step-up code.
 *
 * The parameters are dependency seams for tests; `onDeleted` especially, since
 * its real implementation reloads the page.
 */
export const useDeleteAccount = (
  performDelete: (httpClient: HttpClient, opts: { stepUpOtp: string }) => Promise<void> = deleteAccount,
  requestCode: (httpClient: HttpClient) => Promise<void> = postAccountDeletionCode,
  onDeleted: () => Promise<void> = reloadAfterDeletion,
) => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  const openConfirm = () => dispatch({ type: 'OPEN_CONFIRM' })
  const cancel = () => dispatch({ type: 'CANCEL' })
  const setOtp = (otp: string) => dispatch({ type: 'OTP_CHANGED', payload: otp })

  /** Confirm step → email the code and advance to code entry. Also the Resend handler. */
  const requestStepUpCode = async () => {
    dispatch({ type: 'START_REQUEST' })
    try {
      await requestCode(httpClient)
      dispatch({ type: 'CODE_SENT' })
    } catch (err) {
      dispatch({ type: 'REQUEST_FAILED', payload: requestErrorMessage(err) })
    }
  }

  const confirmDeletion = async () => {
    dispatch({ type: 'START_DELETE' })
    try {
      await performDelete(httpClient, { stepUpOtp: state.otp })
    } catch (err) {
      const rejected = err instanceof StepUpVerificationError
      dispatch({
        type: rejected ? 'CODE_REJECTED' : 'DELETE_FAILED',
        payload: i18n._(rejected ? codeRejected : deleteFailed),
      })
      return
    }
    await onDeleted()
  }

  return { ...state, openConfirm, cancel, setOtp, requestStepUpCode, confirmDeletion }
}
