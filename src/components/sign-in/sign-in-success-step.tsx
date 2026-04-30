/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { CheckCircle2 } from 'lucide-react'

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
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
      </div>

      {/* Welcome message */}
      <h2 className="mt-4 text-xl font-semibold">{displayName ? `Welcome, ${displayName}!` : 'Welcome!'}</h2>
      <p className="mt-1 text-sm text-muted-foreground">You&apos;re now signed in.</p>

      {/* Continue button */}
      <div className={variant === 'modal' ? 'mt-6 w-full' : 'mt-8 w-full'}>
        <Button onClick={onContinue} className="w-full">
          Continue
        </Button>
      </div>
    </div>
  )
}
