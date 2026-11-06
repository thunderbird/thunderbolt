/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'
import { Trans } from '@lingui/react/macro'

type SignInSuccessStepProps = {
  displayName?: string
  onContinue: () => void
  variant: 'modal' | 'page'
}

/**
 * Success step for sign-in form.
 * Shows a welcome message after successful authentication.
 */
export const SignInSuccessStep = ({ displayName, onContinue, variant }: SignInSuccessStepProps) => {
  return (
    <div className="flex w-full flex-col items-center text-center">
      {/* Success icon */}
      <GradientCircleCheck className="h-12 w-12" />

      {/* Welcome message */}
      <h2 className="mt-4 text-xl font-semibold">
        {displayName ? <Trans>Welcome, {displayName}!</Trans> : <Trans>Welcome!</Trans>}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <Trans>You&apos;re now signed in.</Trans>
      </p>

      {/* Continue button */}
      <div className={variant === 'modal' ? 'mt-6 w-full' : 'mt-8 w-full'}>
        <Button onClick={onContinue} className="w-full">
          <Trans>Continue</Trans>
        </Button>
      </div>
    </div>
  )
}
