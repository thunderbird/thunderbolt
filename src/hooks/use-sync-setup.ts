import { useReducer } from 'react'
import { useHttpClient } from '@/contexts'
import {
  registerThisDevice,
  completeFirstDeviceSetup,
  checkApprovalAndUnwrap,
  recoverWithKey,
} from '@/services/encryption'

type SyncSetupStep =
  | 'intro'
  | 'detecting'
  | 'first-device-setup'
  | 'recovery-key-display'
  | 'approval-waiting'
  | 'recovery-key-entry'
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
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

const initialState: SyncSetupState = {
  step: 'intro',
  recoveryKey: '',
  recoveryKeyInput: '',
  recoveryKeyError: null,
  approvalError: null,
  isLoading: false,
  error: null,
}

const reducer = (state: SyncSetupState, action: SyncSetupAction): SyncSetupState => {
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
    case 'GO_BACK':
      return { ...initialState, step: 'intro' }
    case 'RESET':
      return initialState
    default:
      return state
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

      if (result.status === 'TRUSTED') {
        // Device already trusted — try to unwrap CK from existing envelope
        const unwrapped = await checkApprovalAndUnwrap(httpClient)
        if (unwrapped) {
          // CK recovered — signal completion via a special state
          // The caller (modal) should detect this and call onComplete
          dispatch({ type: 'STOP_LOADING' })
          return 'already-trusted' as const
        }
        // Envelope missing — treat as first device scenario
        dispatch({ type: 'DETECTED_FIRST_DEVICE' })
        return 'first-device' as const
      }

      if ('firstDevice' in result && result.firstDevice) {
        dispatch({ type: 'DETECTED_FIRST_DEVICE' })
        return 'first-device' as const
      }

      dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
      return 'additional-device' as const
    } catch (err) {
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
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set up encryption'
      dispatch({ type: 'SET_ERROR', payload: message })
      return false
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
      const message = err instanceof Error ? err.message : 'Recovery failed'
      if (message === 'Invalid recovery key') {
        dispatch({
          type: 'SET_RECOVERY_KEY_ERROR',
          payload: 'Invalid recovery phrase. Please check that all words are correct and in the right order.',
        })
      } else {
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
      const message = err instanceof Error ? err.message : 'Failed to check approval'
      dispatch({ type: 'SET_APPROVAL_ERROR', payload: message })
      return false
    }
  }

  const completeSetup = () => dispatch({ type: 'SETUP_COMPLETE' })
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
    completeSetup,
    reset,
  }
}
