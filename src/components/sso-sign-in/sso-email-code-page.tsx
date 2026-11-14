/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLocation, useNavigate } from 'react-router'
import { SignInForm } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { SsoSignInLayout } from './sso-sign-in-layout'

/**
 * Email-code sign-in in an SSO deployment, for people no identity provider manages (an invited
 * contractor, a break-glass admin). The server decides who may use it: it refuses an address with
 * no admission, and a member an identity provider manages.
 */
export const SsoEmailCodePage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email
  const backToSso = () => navigate('/sso-redirect', { replace: true })

  return (
    <SsoSignInLayout
      title={<Trans>Sign in with an email code</Trans>}
      description={<Trans>We'll send a sign-in code to your email address.</Trans>}
    >
      <SignInForm
        variant="modal"
        initialEmail={email}
        onSuccess={() => window.location.replace('/')}
        onCancel={backToSso}
      />
      <Button type="button" variant="ghost" onClick={backToSso}>
        <Trans>Back to organization sign-in</Trans>
      </Button>
    </SsoSignInLayout>
  )
}
