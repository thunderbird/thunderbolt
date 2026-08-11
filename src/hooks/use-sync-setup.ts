/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { HttpError } from '@/lib/http'
import { useHttpClient, type HttpClient } from '@/contexts'
import { ValidationError } from '@/crypto'
import {
  registerThisDevice,
  completeFirstDeviceSetup,
  checkApprovalAndUnwrap,
  handleFullWipe,
  recoverWithKey,
} from '@/services/encryption'
import {
  checkCanaryExists,
  fetchEncryptionMetadata,
  resetV1Encryption,
  type EncryptionMetadata,
} from '@/api/encryption'

type SyncSetupStep =
  | 'intro'
  | 'detecting'
  | 'first-device-setup'
  | 'recovery-key-display'
  | 'approval-waiting'
  | 'recovery-key-entry'
  | 'denied'
  | 'v1-reset'
  | 'setup-complete'

type SyncSetupState = {
  step: SyncSetupStep
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
  | { type: 'DETECTED_V1_ACCOUNT' }
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
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

export const initialState: SyncSetupState = {
  step: 'intro',
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
    case 'DETECTED_V1_ACCOUNT':
      return { ...state, step: 'v1-reset', isLoading: false }
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
 * - `v1` — metadata predating v2 (NULL signing_public_key): beta reset needed
 * - `v2` — current key hierarchy: normal additional-device flow
 */
export const classifyEncryptionMetadata = (metadata: EncryptionMetadata | null): 'none' | 'v1' | 'v2' => {
  if (!metadata) {
    return 'none'
  }
  return metadata.signing_public_key == null ? 'v1' : 'v2'
}

/** Fetch encryption metadata, mapping the 404 "not set up" case to null. */
const fetchMetadataOrNull = async (httpClient: HttpClient): Promise<EncryptionMetadata | null> => {
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
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  const continueIntro = async () => {
    dispatch({ type: 'CONTINUE_INTRO' })

    try {
      const result = await registerThisDevice(httpClient)
      const accountState = classifyEncryptionMetadata(await fetchMetadataOrNull(httpClient))

      // v1 beta account: its keys and canary predate the v2 hierarchy and are
      // unusable — route to the reset explanation before any envelope/approval
      // path runs (a v1 envelope can't be unwrapped with v2 keys).
      if (accountState === 'v1') {
        dispatch({ type: 'DETECTED_V1_ACCOUNT' })
        return 'v1-account' as const
      }

      if (result.trusted) {
        // Device already trusted — try to unwrap the AK from an existing envelope
        const unwrapped = await checkApprovalAndUnwrap(httpClient)
        if (unwrapped) {
          dispatch({ type: 'SETUP_COMPLETE' })
          return 'already-trusted' as const
        }
        // Trusted but no envelope — fall through to the metadata check below
      }

      if (accountState === 'none') {
        dispatch({ type: 'DETECTED_FIRST_DEVICE' })
        return 'first-device' as const
      }

      dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
      return 'additional-device' as const
    } catch (err) {
      if (err instanceof HttpError && err.response.status === 422) {
        dispatch({
          type: 'SET_ERROR',
          payload: 'You have reached the maximum number of devices. Revoke an existing device to add a new one.',
        })
        return 'error' as const
      }
      const message = err instanceof Error ? err.message : 'Failed to register device'
      dispatch({ type: 'SET_ERROR', payload: message })
      return 'error' as const
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
      const message = err instanceof Error ? err.message : 'Failed to set up encryption'
      dispatch({ type: 'SET_ERROR', payload: message })
    }
  }

  /**
   * Confirm the v1 → v2 beta reset: wipe the server-side v1 encryption state
   * and any local key leftovers, then continue into a fresh v2 first-device
   * setup. A 409 means the account is actually v2 (e.g. another device raced
   * us and completed setup) — fall through to the normal additional-device
   * flow instead.
   */
  const continueV1Reset = async () => {
    dispatch({ type: 'START_LOADING' })

    try {
      await resetV1Encryption(httpClient)
    } catch (err) {
      if (err instanceof HttpError && err.response.status === 409) {
        dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to reset encryption'
      dispatch({ type: 'SET_ERROR', payload: message })
      return
    }

    await handleFullWipe()
    // The initial account-status check registered a fresh v2 device keypair.
    // Recreate it after wiping legacy key storage so bootstrap has keys to wrap.
    await registerThisDevice(httpClient)
    dispatch({ type: 'DETECTED_FIRST_DEVICE' })
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
        // The v1 "redo setup" ValidationError carries an actionable message —
        // don't mask it with the generic wrong-phrase copy.
        const isV1RedoSetup = err.message.includes('outdated encryption setup')
        dispatch({
          type: 'SET_RECOVERY_KEY_ERROR',
          payload: isV1RedoSetup
            ? err.message
            : 'Invalid recovery phrase. Please check that all words are correct and in the right order.',
        })
      } else {
        const message = err instanceof Error ? err.message : 'Recovery failed'
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
          payload: 'This device has not been approved yet. Please approve it from a trusted device first.',
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
      const message = err instanceof Error ? err.message : 'Failed to check approval'
      dispatch({ type: 'SET_APPROVAL_ERROR', payload: message })
      return false
    }
  }

  const completeSetup = () => dispatch({ type: 'SETUP_COMPLETE' })
  const deviceDenied = () => dispatch({ type: 'DEVICE_DENIED' })
  const reset = () => dispatch({ type: 'RESET' })

  return {
    ...state,
    continueIntro,
    goBack,
    continueFirstDeviceSetup,
    continueV1Reset,
    goToRecoveryKeyEntry,
    chooseAdditionalDevice,
    setRecoveryKeyInput,
    submitRecoveryKey,
    confirmApproval,
    completeSetup,
    deviceDenied,
    reset,
  }
}
