/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { SignInModal } from '@/components/sign-in-modal'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { useConfigStore } from '@/api/config-store'
import { useAuth } from '@/contexts/auth-context'
import { isSyncEnabled, setSyncEnabled } from '@/db/powersync/sync-state'
import { needsSyncSetupWizard } from '@/db/encryption'
import { showSignInModalEvent, signInSuccessEvent } from '@/hooks/use-credential-events'
import { isSsoMode } from '@/lib/auth-mode'
import { createHandleError } from '@/lib/error-utils'
import { isPrPreview } from '@/lib/platform'
import { trackError, trackEvent } from '@/lib/posthog'

type SignInModalContextValue = {
  openSignInModal: () => void
}

export type ReEnrollmentCheckDeps = {
  /** Deployment-level E2EE flag, from the persisted `/config` store. */
  e2eeEnabled: boolean
  /** Session has resolved AND a user is present. */
  isSignedIn: boolean
  syncEnabled: () => boolean
  needsWizard: () => Promise<boolean>
}

/**
 * Whether an already signed-in session must be pushed back through the sync
 * setup wizard because this device can no longer decrypt what it is syncing.
 *
 * Every condition is load-bearing: without `syncEnabled` we would nag devices
 * that deliberately keep sync off (a missing keyring is not a problem until
 * something is replicating), and without `isSignedIn` the wizard's calls would
 * fire unauthenticated against a stale local sync preference.
 */
export const shouldPromptReEnrollment = async ({
  e2eeEnabled,
  isSignedIn,
  syncEnabled,
  needsWizard,
}: ReEnrollmentCheckDeps): Promise<boolean> => {
  if (!e2eeEnabled || !isSignedIn || !syncEnabled()) {
    return false
  }
  return needsWizard()
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

  const e2eeEnabled = useConfigStore((state) => state.config.e2eeEnabled)
  const { data: session, isPending: sessionPending } = useAuth().useSession()
  const isSignedIn = !sessionPending && !!session

  useEffect(() => {
    const handler = () => {
      dismissRedirectsToLoggedOutRef.current = true
      setSignInOpen(true)
    }
    window.addEventListener(showSignInModalEvent, handler)
    return () => window.removeEventListener(showSignInModalEvent, handler)
  }, [])

  /**
   * Re-enrollment gate for an ALREADY signed-in session.
   *
   * The wizard used to be reachable only from sign-in and the sync toggle, so a
   * device that lost its keyring mid-session never got offered a way back: a
   * plain reload is neither event, nothing re-evaluated readiness, and PowerSync
   * kept replicating rows the codec could not decrypt — which surfaces as raw
   * `__enc:v2:…` ciphertext in the UI rather than a prompt.
   *
   * The path that motivated this: a v1 device is excluded from the new AK's
   * envelopes when a *peer* migrates the account to v2 (`listEnvelopeCapableDevices`
   * requires an ML-KEM public key, which v1 builds never published), so it can
   * never self-heal over the key-request channel. It has to re-enroll — approval
   * from a trusted device, or the recovery phrase — and the wizard's `detecting`
   * step already routes exactly there for an existing account.
   *
   * Legitimate useEffect: async IndexedDB read once the session and deployment
   * config have settled (`e2eeEnabled` re-runs it when `/config` hydrates late).
   */
  useEffect(() => {
    let cancelled = false
    shouldPromptReEnrollment({
      e2eeEnabled: e2eeEnabled === true,
      isSignedIn,
      syncEnabled: isSyncEnabled,
      needsWizard: needsSyncSetupWizard,
    })
      .then((needed) => {
        if (needed && !cancelled) {
          setSyncSetupOpen(true)
        }
      })
      .catch((error: unknown) => {
        console.warn('[sync-setup] Startup encryption-readiness check failed:', error)
      })
    return () => {
      cancelled = true
    }
  }, [e2eeEnabled, isSignedIn])

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
      // Re-auth from a session-expiry flow lands here with sync already enabled — skip the
      // redundant write and analytics so we only track the first-enable transition.
      if (isSyncEnabled()) {
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
