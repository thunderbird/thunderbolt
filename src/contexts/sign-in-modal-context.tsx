import { createContext, useContext, useState, type ReactNode } from 'react'

import { SignInModal } from '@/components/sign-in-modal'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { setSyncEnabled } from '@/db/powersync'
import { needsSyncSetupWizard } from '@/db/encryption'
import { createHandleError } from '@/lib/error-utils'
import { trackError, trackEvent } from '@/lib/posthog'

type SignInModalContextValue = {
  openSignInModal: () => void
}

const SignInModalContext = createContext<SignInModalContextValue | null>(null)

export const useSignInModal = () => {
  const context = useContext(SignInModalContext)
  if (!context) {
    throw new Error('useSignInModal must be used within SignInModalProvider')
  }
  return context
}

type SignInModalProviderProps = {
  children: ReactNode
}

export const SignInModalProvider = ({ children }: SignInModalProviderProps) => {
  const [signInOpen, setSignInOpen] = useState(false)
  const [syncSetupOpen, setSyncSetupOpen] = useState(false)

  const openSignInModal = () => setSignInOpen(true)

  const handleSignInSuccess = () => {
    setSignInOpen(false)
    const enableSync = async () => {
      if (await needsSyncSetupWizard()) {
        setSyncSetupOpen(true)
        return
      }
      await setSyncEnabled(true)
      trackEvent('settings_sync_enabled')
    }
    enableSync().catch((error) => {
      console.error('Failed to enable sync after sign-in:', error)
      trackError(createHandleError('SYNC_ENABLE_FAILED', 'Failed to enable sync after sign-in', error))
    })
  }

  const handleSyncSetupComplete = async () => {
    await setSyncEnabled(true)
    trackEvent('settings_sync_enabled')
    setSyncSetupOpen(false)
  }

  return (
    <SignInModalContext.Provider value={{ openSignInModal }}>
      {children}
      <SignInModal open={signInOpen} onOpenChange={setSignInOpen} onSuccess={handleSignInSuccess} />
      <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />
    </SignInModalContext.Provider>
  )
}
