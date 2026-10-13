/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

type BrowserCheckProps = {
  /** Present once the check has failed; renders the retry state instead of the spinner. */
  onRetry?: () => void
}

/** Full-screen state shown while the auth gate solves the ALTCHA challenge before anonymous sign-in. */
export const BrowserCheck = ({ onRetry }: BrowserCheckProps) => (
  <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center" role="status">
    {onRetry ? (
      <>
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">
          <Trans>We couldn't verify your browser. Check your connection and try again.</Trans>
        </p>
        <Button onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      </>
    ) : (
      <>
        <Loader2 className="animate-spin text-muted-foreground" size={24} aria-hidden="true" />
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">
          <Trans>Checking your browser…</Trans>
        </p>
      </>
    )}
  </div>
)
