'use client'

import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { SignInForm } from './sign-in'

type SignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Sign-in modal that wraps the reusable SignInForm component.
 * Provides the modal chrome and delegates to SignInForm for all form logic.
 */
export const SignInModal = ({ open, onOpenChange }: SignInModalProps) => {
  const [step, setStep] = useState<'email' | 'otp'>('email')

  const handleClose = () => {
    onOpenChange(false)
    setStep('email')
  }

  const handleGoBack = () => setStep('email')
  const handleGoToOtp = () => setStep('otp')

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalHeader className={step === 'email' ? 'text-center' : ''}>
        {step === 'otp' && (
          <button
            type="button"
            onClick={handleGoBack}
            className="absolute left-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted"
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <ResponsiveModalTitle className={step === 'email' ? 'text-2xl font-semibold' : 'sr-only'}>
          {step === 'email' ? 'Unlock more features' : 'Enter your code'}
        </ResponsiveModalTitle>
        {step === 'email' && (
          <ResponsiveModalDescription>Sign in to get more out of Thunderbolt</ResponsiveModalDescription>
        )}
      </ResponsiveModalHeader>

      <ResponsiveModalContent centered className="gap-4">
        <SignInForm
          variant="modal"
          onSuccess={handleClose}
          onCancel={handleClose}
          onGoBack={handleGoBack}
          onEmailSent={handleGoToOtp}
        />
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
