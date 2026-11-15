/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useHttpClient } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { usePasskeyAvailable } from '@/lib/passkey'
import { isLocalhostUrl } from '@/lib/utils'
import { type ReactNode, type RefObject, useCallback } from 'react'
import { SignInEmailStep } from './sign-in-email-step'
import { SignInOtpStep } from './sign-in-otp-step'
import { SignInSuccessStep } from './sign-in-success-step'
import { useSignInFormState } from './use-sign-in-form-state'
import { Trans } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'

type SignInFormProps = {
  /**
   * Layout variant: 'modal' for use inside ResponsiveModal, 'page' for an auth card (`AuthScreen`)
   */
  variant: 'modal' | 'page'
  /**
   * Called when the user cancels/closes the form
   */
  onCancel?: () => void
  /**
   * Called when the user continues from the welcome step after a successful sign-in
   */
  onSuccess?: () => void
  /**
   * Called as soon as sign-in succeeds, in place of the welcome step: for a host that leaves the
   * form for the app, where onboarding takes over
   */
  onSignedIn?: () => void
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
 * After authentication is accepted, session setup finishes before the welcome step (or `onSignedIn`).
 */
export const SignInForm = ({
  variant,
  onCancel,
  onSuccess,
  onSignedIn,
  onGoBack,
  onEmailSent,
  initialEmail,
  renderBackButton,
  goBackRef,
}: SignInFormProps) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const { preferredName } = useSettings({ preferred_name: '' })
  const isLocalhost = isLocalhostUrl(cloudUrl)
  const displayName = preferredName.value as string
  const passkeyAvailable = usePasskeyAvailable()

  const { state, isValidEmail, actions } = useSignInFormState({
    authClient,
    httpClient,
    onCancel,
    onEmailSent,
    onSignedIn,
    initialEmail,
  })

  const handleGoBack = useCallback(() => {
    if (actions.goBack()) {
      onGoBack?.()
    }
  }, [actions, onGoBack])

  // Expose goBack to parent via ref (for page variant where back button is external).
  if (goBackRef) {
    goBackRef.current = handleGoBack
  }

  if (state.status === 'success' && !onSignedIn) {
    return <SignInSuccessStep displayName={displayName} onContinue={() => onSuccess?.()} variant={variant} />
  }

  // A host with onSignedIn is navigating away, so success holds the same progress line.
  if (state.status === 'completing' || state.status === 'success') {
    return (
      <div role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <Trans>Signing in…</Trans>
      </div>
    )
  }

  // OTP entry state
  if (state.status === 'sent' || state.status === 'resending' || state.status === 'verifying') {
    return (
      <div className={variant === 'modal' ? 'relative h-full w-full' : 'relative w-full'}>
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
          onCancel={actions.handleCancel}
          variant={variant}
        />
      </div>
    )
  }

  return (
    <div className="w-full">
      <SignInEmailStep
        email={state.email}
        status={state.status === 'passkey' ? 'idle' : state.status}
        errorMessage={state.errorMessage}
        isValidEmail={isValidEmail}
        onSubmit={actions.handleSubmit}
        onEmailChange={actions.setEmail}
        variant={variant}
        passkeyAvailable={passkeyAvailable}
        passkeyPending={state.passkeyPending}
        onPasskeySignIn={actions.handlePasskeySignIn}
      />
    </div>
  )
}
