import { useAuth } from '@/contexts'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSettings } from '@/hooks/use-settings'
import { isLocalhostUrl } from '@/lib/utils'
import { ArrowLeft } from 'lucide-react'
import { useRef } from 'react'
import { SignInEmailStep } from './sign-in-email-step'
import { SignInOtpStep } from './sign-in-otp-step'
import { SignInSuccessStep } from './sign-in-success-step'
import { useSignInFormState } from './use-sign-in-form-state'

type SignInFormProps = {
  /**
   * Layout variant: 'modal' for use inside ResponsiveModal, 'page' for standalone page
   */
  variant: 'modal' | 'page'
  /**
   * Called when the user cancels/closes the form
   */
  onCancel?: () => void
  /**
   * Called after successful sign-in
   */
  onSuccess?: () => void
  /**
   * Called when the user navigates back from OTP to email step
   */
  onGoBack?: () => void
  /**
   * Render function for the header back button (modal variant only)
   */
  renderBackButton?: (onClick: () => void) => React.ReactNode
}

/**
 * Reusable sign-in form component.
 * Can be used inside a modal or as a standalone page.
 *
 * Handles three states:
 * - idle/sending/error: Email input
 * - sent/verifying: OTP verification
 * - success: Welcome message
 */
export const SignInForm = ({ variant, onCancel, onSuccess, onGoBack, renderBackButton }: SignInFormProps) => {
  const authClient = useAuth()
  const { cloudUrl, preferredName } = useSettings({ cloud_url: 'http://localhost:8000/v1', preferred_name: '' })
  const isLocalhost = isLocalhostUrl(cloudUrl.value)
  const displayName = preferredName.value as string
  const emailInputRef = useRef<HTMLInputElement>(null)
  const { isMobile } = useIsMobile()

  const { state, actions } = useSignInFormState({
    authClient,
    onSuccess,
    onCancel,
  })

  const handleGoBack = () => {
    actions.goBack()
    onGoBack?.()
  }

  const handleOpenAutoFocus = () => {
    // Only autofocus on desktop - mobile keyboards are disruptive
    if (!isMobile) {
      emailInputRef.current?.focus()
    }
  }

  // Success state
  if (state.status === 'success') {
    return <SignInSuccessStep displayName={displayName} onContinue={() => onSuccess?.()} variant={variant} />
  }

  // OTP entry state
  if (state.status === 'sent' || state.status === 'verifying') {
    return (
      <div className="relative w-full">
        {/* Back button for modal - rendered in header */}
        {variant === 'modal' && renderBackButton?.(handleGoBack)}

        {/* Default back button for modal if no render function provided */}
        {variant === 'modal' && !renderBackButton && (
          <button
            type="button"
            onClick={handleGoBack}
            className="absolute -top-8 left-0 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted"
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}

        <SignInOtpStep
          email={state.email}
          otp={state.otp}
          status={state.status}
          errorMessage={state.errorMessage}
          isLocalhost={isLocalhost}
          onOtpChange={actions.setOtp}
          onOtpComplete={actions.handleOtpComplete}
          onResend={actions.handleResend}
          onGoBack={handleGoBack}
          onCancel={() => onCancel?.()}
          variant={variant}
        />
      </div>
    )
  }

  // Initial email entry state
  return (
    <div className="w-full" ref={() => handleOpenAutoFocus()}>
      <SignInEmailStep
        email={state.email}
        status={state.status}
        errorMessage={state.errorMessage}
        onSubmit={actions.handleSubmit}
        onEmailChange={actions.setEmail}
        variant={variant}
        emailInputRef={emailInputRef}
      />
    </div>
  )
}
