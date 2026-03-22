import { useReducer } from 'react'

// Mock recovery key for UI testing (replaced with real crypto in PR 5)
const mockRecoveryKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'

type SyncSetupStep = 'choose-flow' | 'recovery-key-display' | 'approval-waiting' | 'recovery-key-entry'

type SyncSetupState = {
  step: SyncSetupStep
  recoveryKey: string
  recoveryKeyInput: string
  recoveryKeyError: string | null
  approvalChecked: boolean
  approvalError: string | null
}

type SyncSetupAction =
  | { type: 'CHOOSE_FIRST_DEVICE' }
  | { type: 'CHOOSE_ADDITIONAL_DEVICE' }
  | { type: 'GO_TO_RECOVERY_KEY_ENTRY' }
  | { type: 'SET_RECOVERY_KEY_INPUT'; payload: string }
  | { type: 'SET_RECOVERY_KEY_ERROR'; payload: string | null }
  | { type: 'SET_APPROVAL_CHECKED'; payload: boolean }
  | { type: 'SET_APPROVAL_ERROR'; payload: string | null }
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

const initialState: SyncSetupState = {
  step: 'choose-flow',
  recoveryKey: mockRecoveryKey,
  recoveryKeyInput: '',
  recoveryKeyError: null,
  approvalChecked: false,
  approvalError: null,
}

const reducer = (state: SyncSetupState, action: SyncSetupAction): SyncSetupState => {
  switch (action.type) {
    case 'CHOOSE_FIRST_DEVICE':
      return { ...state, step: 'recovery-key-display' }
    case 'CHOOSE_ADDITIONAL_DEVICE':
      return { ...state, step: 'approval-waiting' }
    case 'GO_TO_RECOVERY_KEY_ENTRY':
      return { ...state, step: 'recovery-key-entry', recoveryKeyInput: '', recoveryKeyError: null }
    case 'SET_RECOVERY_KEY_INPUT':
      return { ...state, recoveryKeyInput: action.payload, recoveryKeyError: null }
    case 'SET_RECOVERY_KEY_ERROR':
      return { ...state, recoveryKeyError: action.payload }
    case 'SET_APPROVAL_CHECKED':
      return { ...state, approvalChecked: action.payload, approvalError: null }
    case 'SET_APPROVAL_ERROR':
      return { ...state, approvalError: action.payload }
    case 'GO_BACK':
      return { ...initialState, step: 'choose-flow' }
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

  const goBack = () => dispatch({ type: 'GO_BACK' })
  const chooseFirstDevice = () => dispatch({ type: 'CHOOSE_FIRST_DEVICE' })
  const chooseAdditionalDevice = () => dispatch({ type: 'CHOOSE_ADDITIONAL_DEVICE' })
  const goToRecoveryKeyEntry = () => dispatch({ type: 'GO_TO_RECOVERY_KEY_ENTRY' })

  const setRecoveryKeyInput = (value: string) => dispatch({ type: 'SET_RECOVERY_KEY_INPUT', payload: value })

  const submitRecoveryKey = () => {
    const cleaned = state.recoveryKeyInput.replace(/\s/g, '')
    if (cleaned.length !== 64) {
      dispatch({ type: 'SET_RECOVERY_KEY_ERROR', payload: 'Recovery key must be 64 characters.' })
      return false
    }
    if (!/^[0-9a-f]+$/i.test(cleaned)) {
      dispatch({ type: 'SET_RECOVERY_KEY_ERROR', payload: 'Recovery key must contain only hex characters (0-9, a-f).' })
      return false
    }
    // Stub: In PR 5, this will verify via canary decryption
    return true
  }

  const setApprovalChecked = (checked: boolean) => dispatch({ type: 'SET_APPROVAL_CHECKED', payload: checked })

  const confirmApproval = () => {
    if (!state.approvalChecked) {
      return false
    }
    // Stub: In PR 5, this will call GET /devices/me/envelope to check if approved
    // For now, always succeed
    return true
  }

  const reset = () => dispatch({ type: 'RESET' })

  return {
    ...state,
    goBack,
    chooseFirstDevice,
    chooseAdditionalDevice,
    goToRecoveryKeyEntry,
    setRecoveryKeyInput,
    submitRecoveryKey,
    setApprovalChecked,
    confirmApproval,
    reset,
  }
}
