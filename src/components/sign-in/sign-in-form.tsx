/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useHttpClient } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { isLocalhostUrl } from '@/lib/utils'
import { type ReactNode, type RefObject, useCallback, useEffect } from 'react'
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
   * Called when the verification email is successfully sent (transitions to OTP step)
   */
  onEmailSent?: () => void
  /**
   * Pre-fill the email input (user still needs to click submit)
   */
  initialEmail?: string
  /**
   * Skip directly to the OTP step (OTP must already be sent before navigating)
   */
  skipToOtp?: boolean
  /**
   * Challenge token to use when skipToOtp is true (required for OTP verification)
   */
  initialChallengeToken?: string
  /**
   * Render function for the header back button (modal variant only)
   */
  renderBackButton?: (onClick: () => void) => ReactNode
  /**
   * Ref that exposes the form's goBack function to the parent.
   * Useful for page variant where the back button lives outside the form.
   */
  goBackRef?: RefObject<(() => void) | null>
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
export const SignInForm = ({
  variant,
  onCancel,
  onSuccess,
  onGoBack,
  onEmailSent,
  initialEmail,
  skipToOtp,
  initialChallengeToken,
  renderBackButton,
  goBackRef,
}: SignInFormProps) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const { cloudUrl, preferredName } = useSettings({ cloud_url: 'http://localhost:8000/v1', preferred_name: '' })
  const isLocalhost = isLocalhostUrl(cloudUrl.value)
  const displayName = preferredName.value as string

  const { state, isValidEmail, actions } = useSignInFormState({
    authClient,
    httpClient,
    onCancel,
    onEmailSent,
    initialEmail,
    skipToOtp,
    initialChallengeToken,
  })

  // When skipping to OTP, notify parent so it can update its step tracking (e.g. back button behavior).
  // Intentionally mount-only: skipToOtp comes from location.state and is stable for the component's lifetime.

  useEffect(() => {
    if (skipToOtp) {
      onEmailSent?.()
    }
  }, [])

  const handleGoBack = useCallback(() => {
    actions.goBack()
    onGoBack?.()
  }, [actions, onGoBack])

  // Expose goBack to parent via ref (for page variant where back button is external).
  if (goBackRef) {
    goBackRef.current = handleGoBack
  }

  // Success state
  if (state.status === 'success') {
    return <SignInSuccessStep displayName={displayName} onContinue={() => onSuccess?.()} variant={variant} />
  }

  // OTP entry state
  if (state.status === 'sent' || state.status === 'verifying') {
    return (
      <div className="relative h-full w-full">
        {/* Optional back button slot - parent can render here if needed */}
        {renderBackButton?.(handleGoBack)}

        <SignInOtpStep
          email={state.email}
          otp={state.otp}
          status={state.status}
          errorMessage={state.errorMessage}
          isLocalhost={isLocalhost}
          onOtpChange={actions.setOtp}
          onOtpComplete={actions.handleOtpComplete}
          onResend={actions.handleResend}
          onCancel={() => onCancel?.()}
          variant={variant}
        />
      </div>
    )
  }

  // Initial email entry state
  return (
    <div className="flex h-full w-full flex-1 flex-col">
      <SignInEmailStep
        email={state.email}
        status={state.status}
        errorMessage={state.errorMessage}
        isValidEmail={isValidEmail}
        onSubmit={actions.handleSubmit}
        onEmailChange={actions.setEmail}
        variant={variant}
      />
    </div>
  )
}
