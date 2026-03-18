import { createNewKey, importFromPassphrase } from '@/crypto'
import type { KeySetupResult } from '@/crypto'
import { useEffect, useReducer, useRef } from 'react'

type SyncSetupStep =
  | 'choose-method'
  | 'create-passphrase'
  | 'create-show-key'
  | 'import-passphrase'
  | 'import-recovery-key'
  | 'passkey-setup'
  | 'success'

type SyncSetupState = {
  step: SyncSetupStep
  passphrase: string
  recoveryKey: string
  recoveryKeySaved: boolean
  isVerifying: boolean
  isRegistering: boolean
  error: string | null
}

type SyncSetupAction =
  | { type: 'SELECT_METHOD'; payload: 'create' | 'import-passphrase' | 'import-recovery-key' }
  | { type: 'SET_PASSPHRASE'; payload: string }
  | { type: 'SHOW_KEY'; payload: string }
  | { type: 'CONFIRM_KEY_SAVED'; payload: boolean }
  | { type: 'SET_VERIFYING'; payload: boolean }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'SET_REGISTERING'; payload: boolean }
  | { type: 'PASSKEY_COMPLETE' }
  | { type: 'SKIP_PASSKEY' }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'GO_BACK' }
  | { type: 'RESET' }

const initialState: SyncSetupState = {
  step: 'choose-method',
  passphrase: '',
  recoveryKey: '',
  recoveryKeySaved: false,
  isVerifying: false,
  isRegistering: false,
  error: null,
}

const backStepMap: Partial<Record<SyncSetupStep, SyncSetupStep>> = {
  'create-passphrase': 'choose-method',
  'create-show-key': 'create-passphrase',
  'import-passphrase': 'choose-method',
  'import-recovery-key': 'choose-method',
}

const syncSetupReducer = (state: SyncSetupState, action: SyncSetupAction): SyncSetupState => {
  switch (action.type) {
    case 'SELECT_METHOD': {
      const stepMap = {
        create: 'create-passphrase',
        'import-passphrase': 'import-passphrase',
        'import-recovery-key': 'import-recovery-key',
      } as const
      return { ...state, step: stepMap[action.payload], error: null }
    }

    case 'SET_PASSPHRASE':
      return { ...state, passphrase: action.payload }

    case 'SHOW_KEY':
      return { ...state, recoveryKey: action.payload, step: 'create-show-key', error: null }

    case 'CONFIRM_KEY_SAVED':
      return { ...state, recoveryKeySaved: action.payload }

    case 'SET_VERIFYING':
      return { ...state, isVerifying: action.payload, error: null }

    case 'VERIFY_SUCCESS':
      return { ...state, isVerifying: false, step: 'passkey-setup', error: null }

    case 'SET_REGISTERING':
      return { ...state, isRegistering: action.payload }

    case 'PASSKEY_COMPLETE':
      return { ...state, isRegistering: false, step: 'success' }

    case 'SKIP_PASSKEY':
      return { ...state, step: 'success' }

    case 'SET_ERROR':
      return { ...state, isVerifying: false, error: action.payload }

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
        error: null,
      }
    }

    case 'RESET':
      return initialState

    default:
      return state
  }
}

const getErrorMessage = (result: KeySetupResult): string => {
  if (result.success) return ''
  switch (result.error) {
    case 'WRONG_KEY':
      return 'Incorrect passphrase. Please try again.'
    case 'INVALID_FORMAT':
      return 'Invalid recovery key format.'
    case 'SERVER_ERROR':
      return 'Server error. Please try again later.'
    case 'NETWORK_ERROR':
      return 'Network error. Please check your connection.'
  }
}

export const useSyncSetupState = () => {
  const [state, dispatch] = useReducer(syncSetupReducer, initialState)
  const abortRef = useRef(false)

  useEffect(() => {
    return () => {
      abortRef.current = true
    }
  }, [])

  const actions = {
    selectMethod: (method: 'create' | 'import-passphrase' | 'import-recovery-key') =>
      dispatch({ type: 'SELECT_METHOD', payload: method }),

    setPassphrase: (passphrase: string) => dispatch({ type: 'SET_PASSPHRASE', payload: passphrase }),

    skipPassphrase: async () => {
      dispatch({ type: 'SET_VERIFYING', payload: true })
      try {
        const { recoveryKey } = await createNewKey()
        if (abortRef.current) return
        dispatch({ type: 'SET_PASSPHRASE', payload: '' })
        dispatch({ type: 'SHOW_KEY', payload: recoveryKey })
      } catch {
        if (abortRef.current) return
        dispatch({ type: 'SET_ERROR', payload: 'Failed to generate encryption key. Please try again.' })
      }
    },

    generateKey: async (passphrase: string) => {
      dispatch({ type: 'SET_VERIFYING', payload: true })
      try {
        const { recoveryKey } = await createNewKey(passphrase)
        if (abortRef.current) return
        dispatch({ type: 'SET_PASSPHRASE', payload: passphrase })
        dispatch({ type: 'SHOW_KEY', payload: recoveryKey })
      } catch {
        if (abortRef.current) return
        dispatch({ type: 'SET_ERROR', payload: 'Failed to generate encryption key. Please try again.' })
      }
    },

    confirmKeySaved: (saved: boolean) => dispatch({ type: 'CONFIRM_KEY_SAVED', payload: saved }),

    completeKeyCreation: () => {
      // Key is already persisted by createNewKey — just advance to passkey step
      dispatch({ type: 'VERIFY_SUCCESS' })
    },

    startVerification: async (passphrase: string) => {
      dispatch({ type: 'SET_VERIFYING', payload: true })
      try {
        const result = await importFromPassphrase(passphrase)
        if (abortRef.current) return
        if (result.success) {
          dispatch({ type: 'VERIFY_SUCCESS' })
        } else {
          dispatch({ type: 'SET_ERROR', payload: getErrorMessage(result) })
        }
      } catch {
        if (abortRef.current) return
        dispatch({ type: 'SET_ERROR', payload: 'Verification failed. Please try again.' })
      }
    },

    startRecoveryKeyVerification: () => {
      dispatch({ type: 'SET_VERIFYING', payload: true })
      clearPendingTimeout()
      timeoutRef.current = setTimeout(() => {
        setEncryptionKeyState('KEY_PRESENT')
        dispatch({ type: 'VERIFY_SUCCESS' })
      }, 1500)
    },

    skipPasskey: () => dispatch({ type: 'SKIP_PASSKEY' }),

    startPasskeyRegistration: () => {
      // Phase 3 — passkey registration is a stub
      dispatch({ type: 'SET_REGISTERING', payload: true })
      setTimeout(() => {
        dispatch({ type: 'PASSKEY_COMPLETE' })
      }, 500)
    },

    goBack: () => dispatch({ type: 'GO_BACK' }),

    reset: () => {
      abortRef.current = false
      dispatch({ type: 'RESET' })
    },
  }

  return { state, actions }
}

export type { SyncSetupAction, SyncSetupState, SyncSetupStep }
