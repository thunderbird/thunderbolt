import { useReducer, type FormEvent } from 'react'
import type { AuthClient } from '@/contexts'

type ModalStatus = 'idle' | 'sending' | 'sent' | 'verifying' | 'success' | 'error'

type State = {
  email: string
  otp: string
  status: ModalStatus
  errorMessage: string
}

type Action =
  | { type: 'SET_EMAIL'; payload: string }
  | { type: 'SET_OTP'; payload: string }
  | { type: 'START_SENDING' }
  | { type: 'SEND_SUCCESS' }
  | { type: 'SEND_ERROR'; payload: string }
  | { type: 'START_VERIFYING' }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'VERIFY_ERROR'; payload: string }
  | { type: 'RESET' }

const initialState: State = {
  email: '',
  otp: '',
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
      return { ...state, status: 'sent' }
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
    default:
      return state
  }
}

type UseSignInModalStateOptions = {
  authClient: AuthClient
  onClose: () => void
}

/**
 * State hook for SignInModal
 * Separates computation/logic from display for easier testing
 */
export const useSignInModalState = ({ authClient, onClose }: UseSignInModalStateOptions) => {
  const [state, dispatch] = useReducer(reducer, initialState)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const trimmedEmail = state.email.trim()
    if (!trimmedEmail) return

    dispatch({ type: 'START_SENDING' })

    // Send magic link (this generates OTP and sends email with both)
    const { error: magicLinkError } = await authClient.signIn.magicLink({
      email: trimmedEmail,
      callbackURL: '/',
    })

    if (magicLinkError) {
      dispatch({ type: 'SEND_ERROR', payload: magicLinkError.message || 'Failed to send magic link' })
      return
    }

    // Register the OTP with the emailOTP plugin so verification works
    // This doesn't send another email - it just stores the OTP in the database
    const { error: otpError } = await authClient.emailOtp.sendVerificationOtp({
      email: trimmedEmail,
      type: 'sign-in',
    })

    if (otpError) {
      // OTP registration failed, but magic link was sent - user can still use the link
      console.warn('OTP registration failed:', otpError.message)
    }

    dispatch({ type: 'SEND_SUCCESS' })
  }

  const handleOtpComplete = async (value: string) => {
    if (value.length !== 6) return

    dispatch({ type: 'START_VERIFYING' })

    try {
      // Use emailOtp.signIn to verify OTP and create session
      const result = await authClient.signIn.emailOtp({
        email: state.email.trim(),
        otp: value,
      })

      if (result.error) {
        dispatch({ type: 'VERIFY_ERROR', payload: result.error.message || 'Invalid code. Please try again.' })
        return
      }

      // Sign-in successful - show success state
      // Note: Don't refetch session here as it can cause race conditions
      // The session will be updated on next render/navigation
      dispatch({ type: 'VERIFY_SUCCESS' })
    } catch (err) {
      console.error('OTP verification error:', err)
      dispatch({ type: 'VERIFY_ERROR', payload: 'Verification failed. Please try again.' })
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      dispatch({ type: 'RESET' })
      onClose()
    }
  }

  const setEmail = (email: string) => dispatch({ type: 'SET_EMAIL', payload: email })
  const setOtp = (otp: string) => dispatch({ type: 'SET_OTP', payload: otp })

  return {
    state,
    actions: {
      handleSubmit,
      handleOtpComplete,
      handleOpenChange,
      setEmail,
      setOtp,
    },
  }
}
