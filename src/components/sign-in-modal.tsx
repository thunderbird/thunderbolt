/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BackButton } from '@/components/ui/back-button'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
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

  return (
    <ResponsiveModal
      open={open}
      // md:min-h-0 drops the desktop dialog's default 550px minimum so the
      // simple email form doesn't float in empty space (mobile stays
      // full-screen via its own min-h-dvh).
      className="md:min-h-0"
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
          separately below it. Desktop is content-height (md:min-h-0), so
          centering is a no-op there. */}
      <ResponsiveModalContent centered className="flex flex-col gap-4">
        <ResponsiveModalHeader className={step === 'email' ? 'text-center' : ''}>
          <ResponsiveModalTitle className={step === 'email' ? 'text-2xl font-semibold' : 'sr-only'}>
            {step === 'email' ? 'Sign In' : 'Enter your code'}
          </ResponsiveModalTitle>
          {/* sr-only: Radix dialogs want a description for a11y, but the title
              says everything the sighted user needs. */}
          {step === 'email' && (
            <ResponsiveModalDescription className="sr-only">Sign in to Thunderbolt</ResponsiveModalDescription>
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
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
