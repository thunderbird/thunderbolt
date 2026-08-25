/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'

export const SignedOut = () => (
  <div className="flex flex-col items-center justify-center w-full h-dvh">
    <div className="flex flex-col items-center gap-8 text-center">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <AppLogo size={16} />
        <span>Thunderbolt</span>
      </div>

      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">
          <Trans>Signed Out</Trans>
        </h1>
        <p className="text-muted-foreground">
          <Trans>You have been signed out successfully.</Trans>
        </p>
      </div>

      <Button onClick={() => window.location.replace('/')}>
        <Trans>Sign back in</Trans>
      </Button>
    </div>
  </div>
)
