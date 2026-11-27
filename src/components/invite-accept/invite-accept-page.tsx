/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthScreen, AuthScreenHeading, authButtonClass } from '@/components/auth-screen'
import { SignInForm } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { useAppName } from '@/lib/branding-selectors'
import { Trans } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useInviteAcceptState } from './use-invite-accept-state'

/**
 * Where an invitation email's link lands. The invited address signs in by email code, which is
 * what accepts the invitation; the link's token only finds the invitation to show. A successful
 * sign-in goes straight into the app, where onboarding takes over.
 */
export const InviteAcceptPage = () => {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const appName = useAppName()
  const { state, onSignInStarted, retry } = useInviteAcceptState(token)
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const goBackRef = useRef<(() => void) | null>(null)
  const goHome = () => navigate('/', { replace: true })

  const content = (() => {
    switch (state.status) {
      case 'loading':
        return (
          <div role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-[var(--icon-size-sm)] animate-spin" />
            <Trans>Loading your invitation…</Trans>
          </div>
        )
      case 'invalid':
        return (
          <>
            <AuthScreenHeading
              title={<Trans>This invitation is no longer valid</Trans>}
              description={
                <Trans>It may have expired, been used already, or been withdrawn. Ask for a new invitation.</Trans>
              }
            />
            <Button onClick={goHome} className={authButtonClass}>
              <Trans>Sign In</Trans>
            </Button>
          </>
        )
      case 'error':
        return (
          <>
            <AuthScreenHeading
              title={<Trans>Couldn't load this invitation</Trans>}
              description={<Trans>Check your connection and try again.</Trans>}
            />
            <Button onClick={retry} className={authButtonClass}>
              <Trans>Try again</Trans>
            </Button>
          </>
        )
      case 'signed-in': {
        const { email } = state
        return (
          <>
            <AuthScreenHeading
              title={<Trans>You're already signed in</Trans>}
              description={<Trans>You're signed in as {email}.</Trans>}
            />
            <Button onClick={goHome} className={authButtonClass}>
              <Trans>Continue</Trans>
            </Button>
          </>
        )
      }
      case 'valid': {
        const { email } = state
        return (
          <>
            {step === 'email' && (
              <AuthScreenHeading
                title={<Trans>You've been invited to {appName}</Trans>}
                description={<Trans>Sign in with {email} to accept the invitation.</Trans>}
              />
            )}
            <SignInForm
              variant="page"
              initialEmail={email}
              onEmailSent={() => {
                onSignInStarted()
                setStep('otp')
              }}
              onGoBack={() => setStep('email')}
              goBackRef={goBackRef}
              // A full load, so the auth gate reads the new session instead of the signed-out one.
              onSignedIn={() => window.location.replace('/')}
            />
          </>
        )
      }
    }
  })()

  const showBack = state.status === 'valid' && step === 'otp'

  return <AuthScreen onBack={showBack ? () => goBackRef.current?.() : undefined}>{content}</AuthScreen>
}

export default InviteAcceptPage
