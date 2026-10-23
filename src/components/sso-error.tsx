/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link, useSearchParams } from 'react-router'
import { AppWordmark } from '@/components/app-wordmark'
import { useAppName } from '@/lib/branding-selectors'
import { Button } from '@/components/ui/button'
import { getSsoErrorMessage } from '@/lib/sso-error-messages'

/**
 * Where a failed SSO login lands (`errorCallbackURL` in `sso-redirect.tsx`, or `AuthGate` for an error that
 * arrives on `/`). It must not be `/sso-redirect`, which restarts the login on load and would loop.
 */
const SsoError = () => {
  const [searchParams] = useSearchParams()
  const appName = useAppName()
  const { i18n } = useLingui()

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh px-6">
      <div className="flex flex-col items-center gap-8 text-center">
        <AppWordmark />

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">
            <Trans>Sign-in failed</Trans>
          </h1>
          <p className="text-muted-foreground">{i18n._(getSsoErrorMessage(searchParams.get('error'), appName))}</p>
        </div>

        <Button asChild>
          <Link to="/sso-redirect" replace>
            <Trans>Try again</Trans>
          </Link>
        </Button>
      </div>
    </div>
  )
}

export default SsoError
