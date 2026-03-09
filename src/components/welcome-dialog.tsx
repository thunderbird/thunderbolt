import { useState } from 'react'
import { create } from 'zustand'

import { SignInSuccessStep } from '@/components/sign-in/sign-in-success-step'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'

export const useWelcomeStore = create<{
  pending: boolean
  trigger: () => void
  consume: () => boolean
}>((set, get) => ({
  pending: false,
  trigger: () => set({ pending: true }),
  consume: () => {
    const val = get().pending
    if (val) {
      set({ pending: false })
    }
    return val
  },
}))

/**
 * Shows a welcome dialog after successful sign-in from the waitlist page.
 */
export const WelcomeDialog = () => {
  const { preferredName } = useSettings({ preferred_name: '' })
  const [isOpen, setIsOpen] = useState(() => useWelcomeStore.getState().consume())

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
