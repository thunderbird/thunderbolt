import { useHttpClient } from '@/contexts'
import { isValidEmailFormat } from '@/lib/utils'
import { useReducer, type FormEvent } from 'react'

type WaitlistStatus = 'idle' | 'joining' | 'success' | 'error'

type State = {
  email: string
  status: WaitlistStatus
  errorMessage: string
}

type Action =
  | { type: 'SET_EMAIL'; payload: string }
  | { type: 'START_JOINING' }
  | { type: 'JOIN_SUCCESS' }
  | { type: 'JOIN_ERROR'; payload: string }
  | { type: 'RESET' }

const initialState: State = {
  email: '',
  status: 'idle',
  errorMessage: '',
}

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'SET_EMAIL':
      return { ...state, email: action.payload, errorMessage: '' }
    case 'START_JOINING':
      return { ...state, status: 'joining', errorMessage: '' }
    case 'JOIN_SUCCESS':
      return { ...state, status: 'success' }
    case 'JOIN_ERROR':
      return { ...state, status: 'error', errorMessage: action.payload }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

/**
 * State hook for the waitlist join flow.
 * Manages email input and submission to the waitlist API.
 */
export const useWaitlistState = () => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, initialState)

  const isValidEmail = isValidEmailFormat(state.email.trim())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmedEmail = state.email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) return

    dispatch({ type: 'START_JOINING' })

    try {
      await httpClient.post('waitlist/join', {
        json: { email: trimmedEmail },
      })
      dispatch({ type: 'JOIN_SUCCESS' })
    } catch {
      dispatch({ type: 'JOIN_ERROR', payload: 'Failed to join waitlist. Please try again.' })
    }
  }

  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const reset = () => dispatch({ type: 'RESET' })

  return {
    state,
    isValidEmail,
    actions: {
      handleSubmit,
      setEmail,
      reset,
    },
  }
}
