/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { SignInModal } from '@/components/sign-in-modal'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { setSyncEnabled } from '@/db/powersync'
import { needsSyncSetupWizard } from '@/db/encryption'
import { showSignInModalEvent, signInSuccessEvent } from '@/hooks/use-credential-events'
import { isSsoMode } from '@/lib/auth-mode'
import { createHandleError } from '@/lib/error-utils'
import { isPrPreview } from '@/lib/platform'
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
  // True when the modal was opened by session expiry: dismissing should boot the user to the
  // unauthenticated route.
  const dismissRedirectsToLoggedOutRef = useRef(false)

  const openSignInModal = () => setSignInOpen(true)

  useEffect(() => {
    const handler = () => {
      dismissRedirectsToLoggedOutRef.current = true
      setSignInOpen(true)
    }
    window.addEventListener(showSignInModalEvent, handler)
    return () => window.removeEventListener(showSignInModalEvent, handler)
  }, [])

  const handleOpenChange = (open: boolean) => {
    setSignInOpen(open)
    if (open || !dismissRedirectsToLoggedOutRef.current) {
      return
    }
    dismissRedirectsToLoggedOutRef.current = false
    const shouldBypassWaitlist = import.meta.env.VITE_BYPASS_WAITLIST === 'true' || isPrPreview()
    if (shouldBypassWaitlist) {
      return
    }
    window.location.replace(isSsoMode() ? '/sso-redirect' : '/waitlist')
  }

  const handleSignInSuccess = () => {
    dismissRedirectsToLoggedOutRef.current = false
    setSignInOpen(false)
    window.dispatchEvent(new CustomEvent(signInSuccessEvent))
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
      <SignInModal open={signInOpen} onOpenChange={handleOpenChange} onSuccess={handleSignInSuccess} />
      <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />
    </SignInModalContext.Provider>
  )
}
