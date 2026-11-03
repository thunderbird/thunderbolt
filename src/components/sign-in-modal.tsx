/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { connectionModalSurfaceClass } from '@/components/ui/modal-styles'
import { ChangeServerButton, ServerConnectionModal } from '@/components/server-connection'
import { thunderboltCloudUrl } from '@/lib/constants'
import { isSsoMode } from '@/lib/auth-mode'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Trans } from '@lingui/react/macro'
import { useRef, useState } from 'react'
import { SignInForm } from './sign-in'

type SignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

/**
 * Sign-in modal that wraps the reusable SignInForm component.
 * Provides the modal chrome and delegates to SignInForm for all form logic.
 */
export const SignInModal = ({ open, onOpenChange, onSuccess }: SignInModalProps) => {
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const localMode = useLocalSettingsStore((s) => s.localMode)
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const goBackRef = useRef<(() => void) | null>(null)

  const handleClose = () => {
    onOpenChange(false)
    setStep('email')
  }

  const handleSuccess = () => {
    setStep('email')
    if (onSuccess) {
      onSuccess()
    } else {
      onOpenChange(false)
    }
  }

  const handleGoBack = () => {
    goBackRef.current?.()
  }
  const handleGoToOtp = () => setStep('otp')

  if (!cloudUrl || (cloudUrl === thunderboltCloudUrl && localMode)) {
    return <ServerConnectionModal open={open} onOpenChange={onOpenChange} onAuthenticated={handleSuccess} />
  }

  if (isSsoMode()) {
    return (
      <ResponsiveModal open={open} onOpenChange={onOpenChange} className={connectionModalSurfaceClass}>
        <ResponsiveModalContent centered className="flex flex-col gap-4">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              <Trans>Sign In</Trans>
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              <Trans>Continue with your organization's sign-in to connect to this server.</Trans>
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <Button onClick={() => window.location.assign('/sso-redirect')}>
            <Trans>Continue with organization</Trans>
          </Button>
          <ChangeServerButton />
        </ResponsiveModalContent>
      </ResponsiveModal>
    )
  }

  return (
    <ResponsiveModal
      open={open}
      className={connectionModalSurfaceClass}
      onOpenChange={(open) => {
        if (!open) {
          setStep('email')
        }
        onOpenChange(open)
      }}
    >
      {/* The back button stays pinned to the modal's top-left corner,
          outside the centered block. */}
      {step === 'otp' && <BackButton onClick={handleGoBack} className="absolute left-4 top-4" />}

      {/* Header lives INSIDE the centered content block so the title and the
          form center together as one group on mobile's full-screen modal,
          instead of the title pinning to the top with the form floating
          separately below it. */}
      <ResponsiveModalContent centered className="flex flex-col gap-4">
        <ResponsiveModalHeader className={step === 'email' ? 'text-center' : ''}>
          <ResponsiveModalTitle className={step === 'email' ? 'text-2xl font-semibold' : 'sr-only'}>
            {step === 'email' ? <Trans>Sign In</Trans> : <Trans>Enter your code</Trans>}
          </ResponsiveModalTitle>
          {/* sr-only: Radix dialogs want a description for a11y, but the title
              says everything the sighted user needs. */}
          {step === 'email' && (
            <ResponsiveModalDescription className="sr-only">
              <Trans>Sign in to Thunderbolt</Trans>
            </ResponsiveModalDescription>
          )}
        </ResponsiveModalHeader>
        <SignInForm
          variant="modal"
          onSuccess={handleSuccess}
          onCancel={handleClose}
          onGoBack={() => setStep('email')}
          onEmailSent={handleGoToOtp}
          goBackRef={goBackRef}
        />
        {step === 'email' && <ChangeServerButton />}
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
