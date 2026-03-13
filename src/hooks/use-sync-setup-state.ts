import { generateFakeRecoveryKey, setEncryptionKeyState } from '@/lib/encryption-key-store'
import { useEffect, useReducer, useRef } from 'react'

type SyncSetupStep =
  | 'choose-method'
  | 'create-passphrase'
  | 'create-show-key'
  | 'import-passphrase'
  | 'passkey-setup'
  | 'success'

type SyncSetupState = {
  step: SyncSetupStep
  passphrase: string
  recoveryKey: string
  recoveryKeySaved: boolean
  isVerifying: boolean
  isRegistering: boolean
}

type SyncSetupAction =
  | { type: 'SELECT_METHOD'; payload: 'create' | 'import-passphrase' }
  | { type: 'SET_PASSPHRASE'; payload: string }
  | { type: 'SHOW_KEY'; payload: string }
  | { type: 'CONFIRM_KEY_SAVED'; payload: boolean }
  | { type: 'SET_VERIFYING'; payload: boolean }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'SET_REGISTERING'; payload: boolean }
  | { type: 'PASSKEY_COMPLETE' }
  | { type: 'SKIP_PASSKEY' }
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

const initialState: SyncSetupState = {
  step: 'choose-method',
  passphrase: '',
  recoveryKey: '',
  recoveryKeySaved: false,
  isVerifying: false,
  isRegistering: false,
}

const backStepMap: Partial<Record<SyncSetupStep, SyncSetupStep>> = {
  'create-passphrase': 'choose-method',
  'create-show-key': 'create-passphrase',
  'import-passphrase': 'choose-method',
}

const syncSetupReducer = (state: SyncSetupState, action: SyncSetupAction): SyncSetupState => {
  switch (action.type) {
    case 'SELECT_METHOD': {
      const stepMap = {
        create: 'create-passphrase',
        'import-passphrase': 'import-passphrase',
      } as const
      return { ...state, step: stepMap[action.payload] }
    }

    case 'SET_PASSPHRASE':
      return { ...state, passphrase: action.payload }

    case 'SHOW_KEY':
      return { ...state, recoveryKey: action.payload, step: 'create-show-key' }

    case 'CONFIRM_KEY_SAVED':
      return { ...state, recoveryKeySaved: action.payload }

    case 'SET_VERIFYING':
      return { ...state, isVerifying: action.payload }

    case 'VERIFY_SUCCESS':
      return { ...state, isVerifying: false, step: 'passkey-setup' }

    case 'SET_REGISTERING':
      return { ...state, isRegistering: action.payload }

    case 'PASSKEY_COMPLETE':
      return { ...state, isRegistering: false, step: 'success' }

    case 'SKIP_PASSKEY':
      return { ...state, step: 'success' }

    case 'GO_BACK': {
      const prevStep = backStepMap[state.step]
      if (!prevStep) {
        return state
      }
      return {
        ...state,
        step: prevStep,
        recoveryKeySaved: false,
        isVerifying: false,
      }
    }

    case 'RESET':
      return initialState

    default:
      return state
  }
}

export const useSyncSetupState = () => {
  const [state, dispatch] = useReducer(syncSetupReducer, initialState)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  const actions = {
    selectMethod: (method: 'create' | 'import-passphrase') => dispatch({ type: 'SELECT_METHOD', payload: method }),

    setPassphrase: (passphrase: string) => dispatch({ type: 'SET_PASSPHRASE', payload: passphrase }),

    skipPassphrase: () => {
      dispatch({ type: 'SET_PASSPHRASE', payload: '' })
      dispatch({ type: 'SHOW_KEY', payload: generateFakeRecoveryKey() })
    },

    generateKey: (passphrase: string) => {
      dispatch({ type: 'SET_PASSPHRASE', payload: passphrase })
      dispatch({ type: 'SHOW_KEY', payload: generateFakeRecoveryKey() })
    },

    confirmKeySaved: (saved: boolean) => dispatch({ type: 'CONFIRM_KEY_SAVED', payload: saved }),

    completeKeyCreation: () => {
      setEncryptionKeyState('KEY_PRESENT')
      dispatch({ type: 'VERIFY_SUCCESS' })
    },

    startVerification: () => {
      dispatch({ type: 'SET_VERIFYING', payload: true })
      clearPendingTimeout()
      timeoutRef.current = setTimeout(() => {
        setEncryptionKeyState('KEY_PRESENT')
        dispatch({ type: 'VERIFY_SUCCESS' })
      }, 1500)
    },

    skipPasskey: () => dispatch({ type: 'SKIP_PASSKEY' }),

    startPasskeyRegistration: () => {
      dispatch({ type: 'SET_REGISTERING', payload: true })
      clearPendingTimeout()
      timeoutRef.current = setTimeout(() => {
        dispatch({ type: 'PASSKEY_COMPLETE' })
      }, 1500)
    },

    goBack: () => dispatch({ type: 'GO_BACK' }),

    reset: () => {
      clearPendingTimeout()
      dispatch({ type: 'RESET' })
    },
  }

  return { state, actions }
}

export type { SyncSetupAction, SyncSetupState, SyncSetupStep }
