'use client'

import { useState } from 'react'

import { SignInSuccessStep } from '@/components/sign-in/sign-in-success-step'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'

/** Module-level flag — survives route changes since it's just a JS variable. */
let pendingWelcome = false

/** Call after successful OTP verification to show the welcome dialog on the next mount. */
export const triggerWelcome = () => {
  pendingWelcome = true
}

/**
 * Shows a welcome dialog after successful sign-in from the waitlist page.
 */
export const WelcomeDialog = () => {
  const { preferredName } = useSettings({ preferred_name: '' })
  const [isOpen, setIsOpen] = useState(() => {
    if (pendingWelcome) {
      pendingWelcome = false
      return true
    }
    return false
  })

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Welcome</DialogTitle>
        <DialogDescription className="sr-only">Sign-in successful</DialogDescription>
        <SignInSuccessStep
          displayName={preferredName.value as string}
          onContinue={() => setIsOpen(false)}
          variant="modal"
        />
      </DialogContent>
    </Dialog>
  )
}
