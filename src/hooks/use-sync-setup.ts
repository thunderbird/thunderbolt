/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import { useReducer } from 'react'
import { HttpError } from '@/lib/http'
import { useHttpClient, type HttpClient } from '@/contexts'
import { ValidationError } from '@/crypto'
import {
  registerThisDevice,
  completeFirstDeviceSetup,
  checkApprovalAndUnwrap,
  recoverWithKey,
  unlockWithPasskey as unlockWithPasskeySlot,
  ensureV2Encryption,
} from '@/services/encryption'
import { getPasskeyPrfOutput, isPasskeyCancellation } from '@/lib/passkey'
import { checkCanaryExists, fetchEncryptionMetadata } from '@/api/encryption'
import type { EncryptionMetadataResponse } from '@shared/e2ee-types'

type SyncSetupStep =
  | 'intro'
  | 'detecting'
  | 'first-device-setup'
  | 'recovery-key-display'
  | 'approval-waiting'
  | 'recovery-key-entry'
  | 'denied'
  | 'passkey-enroll'
  | 'setup-complete'

type IntroOutcome = 'first-device' | 'migrated' | 'already-trusted' | 'additional-device' | 'error'

/** Where the wizard goes once the optional passkey step is done: close (first device) or the success step. */
type AfterPasskey = 'close' | 'complete'

type SyncSetupState = {
  step: SyncSetupStep
  /** Credential id of the account's passkey slot, from the metadata read at detection; null when none. */
  passkeySlotCredentialId: string | null
  afterPasskey: AfterPasskey
  recoveryKey: string
  recoveryKeyInput: string
  recoveryKeyError: string | null
  approvalError: string | null
  isLoading: boolean
  error: string | null
}

type SyncSetupAction =
  | { type: 'CONTINUE_INTRO' }
  | { type: 'DETECTED_FIRST_DEVICE' }
  | { type: 'DETECTED_ADDITIONAL_DEVICE' }
  | { type: 'SET_RECOVERY_KEY'; payload: string }
  | { type: 'GO_TO_RECOVERY_KEY_ENTRY' }
  | { type: 'SET_RECOVERY_KEY_INPUT'; payload: string }
  | { type: 'SET_RECOVERY_KEY_ERROR'; payload: string | null }
  | { type: 'SET_APPROVAL_ERROR'; payload: string | null }
  | { type: 'START_LOADING' }
  | { type: 'STOP_LOADING' }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SETUP_COMPLETE' }
  | { type: 'DEVICE_DENIED' }
  | { type: 'SET_PASSKEY_SLOT'; payload: string | null }
  | { type: 'GO_TO_PASSKEY_ENROLL'; payload: AfterPasskey }
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

export const initialState: SyncSetupState = {
  step: 'intro',
  passkeySlotCredentialId: null,
  afterPasskey: 'complete',
  recoveryKey: '',
  recoveryKeyInput: '',
  recoveryKeyError: null,
  approvalError: null,
  isLoading: false,
  error: null,
}

export const reducer = (state: SyncSetupState, action: SyncSetupAction): SyncSetupState => {
  switch (action.type) {
    case 'CONTINUE_INTRO':
      return { ...state, step: 'detecting', isLoading: true, error: null }
    case 'DETECTED_FIRST_DEVICE':
      return { ...state, step: 'first-device-setup', isLoading: false }
    case 'DETECTED_ADDITIONAL_DEVICE':
      return { ...state, step: 'approval-waiting', isLoading: false }
    case 'SET_RECOVERY_KEY':
      return { ...state, recoveryKey: action.payload, step: 'recovery-key-display', isLoading: false }
    case 'GO_TO_RECOVERY_KEY_ENTRY':
      return { ...state, step: 'recovery-key-entry', recoveryKeyInput: '', recoveryKeyError: null }
    case 'SET_RECOVERY_KEY_INPUT':
      return { ...state, recoveryKeyInput: action.payload, recoveryKeyError: null }
    case 'SET_RECOVERY_KEY_ERROR':
      return { ...state, recoveryKeyError: action.payload, isLoading: false }
    case 'SET_APPROVAL_ERROR':
      return { ...state, approvalError: action.payload, isLoading: false }
    case 'START_LOADING':
      return { ...state, isLoading: true, error: null }
    case 'STOP_LOADING':
      return { ...state, isLoading: false }
    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false }
    case 'CLEAR_ERROR':
      return { ...state, error: null }
    case 'SETUP_COMPLETE':
      return { ...state, step: 'setup-complete', isLoading: false }
    case 'DEVICE_DENIED':
      return { ...state, step: 'denied', isLoading: false }
    case 'SET_PASSKEY_SLOT':
      return { ...state, passkeySlotCredentialId: action.payload }
    case 'GO_TO_PASSKEY_ENROLL':
      return { ...state, step: 'passkey-enroll', afterPasskey: action.payload, isLoading: false }
    case 'GO_BACK':
      return { ...initialState, step: 'intro' }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

/**
 * Classify the account's server-side encryption state from its metadata:
 * - `none` — no metadata (404): fresh account, this is the first device
 * - `v1` — legacy pre-hierarchy account (`scheme_version === 1`): routes into
 *   the seamless v1→v2 migration (never a reset)
 * - `v2` — current key hierarchy: normal additional-device / follower flow
 */
export const classifyEncryptionMetadata = (metadata: EncryptionMetadataResponse | null): 'none' | 'v1' | 'v2' => {
  if (!metadata) {
    return 'none'
  }
  return metadata.scheme_version === 1 ? 'v1' : 'v2'
}

/** Fetch encryption metadata, mapping the 404 "not set up" case to null. */
const fetchMetadataOrNull = async (httpClient: HttpClient): Promise<EncryptionMetadataResponse | null> => {
  try {
    return await fetchEncryptionMetadata(httpClient)
  } catch (err) {
    if (err instanceof HttpError && err.response.status === 404) {
      return null
    }
    throw err
  }
}

/**
 * State machine for the sync setup wizard.
 * Orchestrates device registration, key generation, and encryption setup flows.
 */
export const useSyncSetup = () => {
  const { t } = useLingui()
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  /**
   * Register this device and route the wizard. Also returns the account's passkey
   * slot as just detected, because a caller acting on the result in the same tick
   * would otherwise read the slot from the render before detection ran.
   */
  const continueIntro = async (): Promise<{ outcome: IntroOutcome; passkeySlotCredentialId: string | null }> => {
    dispatch({ type: 'CONTINUE_INTRO' })

    try {
      await registerThisDevice(httpClient)
      const metadata = await fetchMetadataOrNull(httpClient)
      const passkeySlotCredentialId = metadata?.passkey_credential_id ?? null
      const done = (outcome: IntroOutcome) => ({ outcome, passkeySlotCredentialId })
      dispatch({ type: 'SET_PASSKEY_SLOT', payload: passkeySlotCredentialId })
      const accountState = classifyEncryptionMetadata(metadata)

      if (accountState === 'none') {
        // No server-side encryption yet — this device bootstraps it.
        dispatch({ type: 'DETECTED_FIRST_DEVICE' })
        return done('first-device')
      }

      // v1 or v2 account: the idempotent migrator/follower dispatcher decides
      // whether this device migrates (v1 + holds the legacy CK), follows (v2 or
      // an already-migrated account), or must wait for approval. A v1 account
      // routes into the seamless migration — never a reset.
      const result = await ensureV2Encryption(httpClient)
      switch (result.outcome) {
        case 'migrated':
          dispatch({ type: 'SET_RECOVERY_KEY', payload: result.recoveryKey })
          return done('migrated')
        case 'followed':
        case 'already-v2':
          dispatch({ type: 'SETUP_COMPLETE' })
          return done('already-trusted')
        case 'awaiting-approval':
        case 'not-applicable':
          dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
          return done('additional-device')
      }
    } catch (err) {
      if (err instanceof HttpError && err.response.status === 422) {
        dispatch({
          type: 'SET_ERROR',
          payload: i18n._(
            msg`You have reached the maximum number of devices. Revoke an existing device to add a new one.`,
          ),
        })
        return { outcome: 'error', passkeySlotCredentialId: null }
      }
      const message = err instanceof Error ? err.message : t`Failed to register device`
      dispatch({ type: 'SET_ERROR', payload: message })
      return { outcome: 'error', passkeySlotCredentialId: null }
    }
  }

  const goBack = () => dispatch({ type: 'GO_BACK' })

  const continueFirstDeviceSetup = async () => {
    dispatch({ type: 'START_LOADING' })

    try {
      const recoveryKey = await completeFirstDeviceSetup(httpClient)
      dispatch({ type: 'SET_RECOVERY_KEY', payload: recoveryKey })
    } catch (err) {
      // Another device may have completed first-device setup — check canary and switch flow
      if (err instanceof HttpError && err.response.status === 403) {
        try {
          const hasCanary = await checkCanaryExists(httpClient)
          if (hasCanary) {
            dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
            return
          }
        } catch {
          dispatch({ type: 'RESET' })
          return
        }
      }
      const message = err instanceof Error ? err.message : t`Failed to set up encryption`
      dispatch({ type: 'SET_ERROR', payload: message })
    }
  }

  const goToRecoveryKeyEntry = () => dispatch({ type: 'GO_TO_RECOVERY_KEY_ENTRY' })
  const chooseAdditionalDevice = () => dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })

  const setRecoveryKeyInput = (value: string) => dispatch({ type: 'SET_RECOVERY_KEY_INPUT', payload: value })

  const submitRecoveryKey = async () => {
    const normalized = state.recoveryKeyInput.trim().toLowerCase().replace(/\s+/g, ' ')
    const wordCount = normalized.split(' ').length

    if (wordCount !== 24) {
      dispatch({
        type: 'SET_RECOVERY_KEY_ERROR',
        payload: `Recovery phrase must be 24 words (you entered ${wordCount}).`,
      })
      return false
    }

    dispatch({ type: 'START_LOADING' })

    try {
      await recoverWithKey(httpClient, normalized)
      return true
    } catch (err) {
      if (err instanceof ValidationError) {
        dispatch({
          type: 'SET_RECOVERY_KEY_ERROR',
          payload: i18n._(
            msg`Invalid recovery phrase. Please check that all words are correct and in the right order.`,
          ),
        })
      } else {
        const message = err instanceof Error ? err.message : i18n._(msg`Recovery failed`)
        dispatch({ type: 'SET_RECOVERY_KEY_ERROR', payload: message })
      }
      return false
    }
  }

  const confirmApproval = async () => {
    dispatch({ type: 'START_LOADING' })

    try {
      const approved = await checkApprovalAndUnwrap(httpClient)
      if (!approved) {
        dispatch({
          type: 'SET_APPROVAL_ERROR',
          payload: i18n._(msg`This device has not been approved yet. Please approve it from a trusted device first.`),
        })
        return false
      }
      dispatch({ type: 'STOP_LOADING' })
      return true
    } catch (err) {
      if (err instanceof HttpError && err.response.status === 422) {
        dispatch({ type: 'DEVICE_DENIED' })
        return false
      }
      const message = err instanceof Error ? err.message : t`Failed to check approval`
      dispatch({ type: 'SET_APPROVAL_ERROR', payload: message })
      return false
    }
  }

  /**
   * Unlock this device with the account's passkey instead of waiting for
   * approval. Returns true once the device holds the keys.
   */
  const unlockWithPasskey = async () => {
    const credentialId = state.passkeySlotCredentialId
    if (!credentialId) {
      return false
    }
    dispatch({ type: 'START_LOADING' })
    try {
      const prfOutput = await getPasskeyPrfOutput(credentialId)
      if (!prfOutput) {
        dispatch({ type: 'SET_APPROVAL_ERROR', payload: i18n._(msg`This passkey can't unlock sync on this device.`) })
        return false
      }
      await unlockWithPasskeySlot(httpClient, { credentialId, prfOutput })
      return true
    } catch (err) {
      if (isPasskeyCancellation(err)) {
        dispatch({ type: 'STOP_LOADING' })
        return false
      }
      console.error('Passkey unlock failed:', err)
      const message =
        err instanceof ValidationError
          ? i18n._(msg`This passkey can't unlock sync for this account.`)
          : i18n._(msg`Couldn't unlock sync with your passkey. Please try again.`)
      dispatch({ type: 'SET_APPROVAL_ERROR', payload: message })
      return false
    }
  }

  const goToPasskeyEnroll = (after: AfterPasskey) => dispatch({ type: 'GO_TO_PASSKEY_ENROLL', payload: after })
  const completeSetup = () => dispatch({ type: 'SETUP_COMPLETE' })
  const deviceDenied = () => dispatch({ type: 'DEVICE_DENIED' })
  const reset = () => dispatch({ type: 'RESET' })

  return {
    ...state,
    continueIntro,
    goBack,
    continueFirstDeviceSetup,
    goToRecoveryKeyEntry,
    chooseAdditionalDevice,
    setRecoveryKeyInput,
    submitRecoveryKey,
    confirmApproval,
    unlockWithPasskey,
    goToPasskeyEnroll,
    completeSetup,
    deviceDenied,
    reset,
  }
}
