/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SignInForm } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { useAppName } from '@/lib/branding-selectors'
import { Trans } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useInviteAcceptState } from './use-invite-accept-state'

const InviteMessage = ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
  <div className="flex flex-col gap-2 text-center">
    <h1 className="text-2xl font-semibold">{title}</h1>
    {children && <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{children}</p>}
  </div>
)

/**
 * Where an invitation email's link lands. The invited address signs in by email code, which is
 * what accepts the invitation; the link's token only finds the invitation to show.
 */
export const InviteAcceptPage = () => {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const appName = useAppName()
  const { state, onSignInStarted, retry } = useInviteAcceptState(token)
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
            <InviteMessage title={<Trans>This invitation is no longer valid</Trans>}>
              <Trans>It may have expired, been used already, or been withdrawn. Ask for a new invitation.</Trans>
            </InviteMessage>
            <Button onClick={goHome}>
              <Trans>Sign In</Trans>
            </Button>
          </>
        )
      case 'error':
        return (
          <>
            <InviteMessage title={<Trans>Couldn't load this invitation</Trans>}>
              <Trans>Check your connection and try again.</Trans>
            </InviteMessage>
            <Button onClick={retry}>
              <Trans>Try again</Trans>
            </Button>
          </>
        )
      case 'signed-in': {
        const { email } = state
        return (
          <>
            <InviteMessage title={<Trans>You're already signed in</Trans>}>
              <Trans>You're signed in as {email}.</Trans>
            </InviteMessage>
            <Button onClick={goHome}>
              <Trans>Continue</Trans>
            </Button>
          </>
        )
      }
      case 'valid': {
        const { email } = state
        return (
          <>
            <InviteMessage title={<Trans>You've been invited to {appName}</Trans>}>
              <Trans>Sign in with {email} to accept the invitation.</Trans>
            </InviteMessage>
            <SignInForm
              variant="modal"
              initialEmail={email}
              onEmailSent={onSignInStarted}
              onSuccess={goHome}
              onCancel={goHome}
            />
          </>
        )
      }
    }
  })()

  return (
    <div
      className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-4"
      style={{ paddingTop: 'var(--safe-area-top-padding)', paddingBottom: 'var(--safe-area-bottom-padding)' }}
    >
      <main className="flex w-full max-w-sm flex-col gap-6">{content}</main>
    </div>
  )
}

export default InviteAcceptPage
