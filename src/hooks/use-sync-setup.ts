import { useReducer } from 'react'

// Mock recovery phrase for UI testing (replaced with real BIP-39 mnemonic in PR 5)
const mockRecoveryPhrase =
  'abandon ability able about above absent absorb abstract absurd abuse access accident alcohol alien alpha already amateur amazing among amount amused analyst anchor annual'

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
 * All crypto/API calls are stubs — replaced with real implementations in PR 5.
 */
export const useSyncSetup = () => {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Stub: In PR 5, this will call registerThisDevice() and auto-detect first vs additional
  const continueIntro = () => {
    dispatch({ type: 'CONTINUE_INTRO' })
    // Mock auto-detection: always treats as first device
    dispatch({ type: 'DETECTED_FIRST_DEVICE' })
  }

  const goBack = () => dispatch({ type: 'GO_BACK' })

  // Stub: In PR 5, this will call completeFirstDeviceSetup() to generate real keys
  const continueFirstDeviceSetup = () => {
    dispatch({ type: 'SET_RECOVERY_KEY', payload: mockRecoveryPhrase })
  }

  const chooseAdditionalDevice = () => dispatch({ type: 'DETECTED_ADDITIONAL_DEVICE' })
  const goToRecoveryKeyEntry = () => dispatch({ type: 'GO_TO_RECOVERY_KEY_ENTRY' })

  const setRecoveryKeyInput = (value: string) => dispatch({ type: 'SET_RECOVERY_KEY_INPUT', payload: value })

  const submitRecoveryKey = () => {
    const normalized = state.recoveryKeyInput.trim().toLowerCase().replace(/\s+/g, ' ')
    const wordCount = normalized.split(' ').length

    if (wordCount !== 24) {
      dispatch({
        type: 'SET_RECOVERY_KEY_ERROR',
        payload: `Recovery phrase must be 24 words (you entered ${wordCount}).`,
      })
      return false
    }

    // Stub: In PR 5, this will verify via canary decryption
    return true
  }

  // Stub: In PR 5, this will call checkApprovalAndUnwrap()
  const confirmApproval = () => true

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
