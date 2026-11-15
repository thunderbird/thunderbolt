/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { AuthScreen, AuthScreenHeading, authButtonClass } from '@/components/auth-screen'
import { SignInForm } from '@/components/sign-in'
import { Button } from '@/components/ui/button'

/**
 * Email-code sign-in in an SSO deployment, for people no identity provider manages (an invited
 * contractor, a break-glass admin). The server decides who may use it: it refuses an address with
 * no admission, and a member an identity provider manages. A successful sign-in goes straight into
 * the app, where onboarding takes over.
 */
export const SsoEmailCodePage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const goBackRef = useRef<(() => void) | null>(null)
  const backToSso = () => navigate('/sso-redirect', { replace: true })

  return (
    <AuthScreen onBack={step === 'otp' ? () => goBackRef.current?.() : undefined}>
      {step === 'email' && (
        <AuthScreenHeading
          title={<Trans>Sign in with an email code</Trans>}
          description={<Trans>We'll send a sign-in code to your email address.</Trans>}
        />
      )}
      <div className="flex w-full flex-col gap-4">
        <SignInForm
          variant="page"
          initialEmail={email}
          onEmailSent={() => setStep('otp')}
          onGoBack={() => setStep('email')}
          goBackRef={goBackRef}
          onSignedIn={() => window.location.replace('/')}
        />
        <Button type="button" variant="ghost" onClick={backToSso} className={authButtonClass}>
          <Trans>Back to organization sign-in</Trans>
        </Button>
      </div>
    </AuthScreen>
  )
}
