/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Trans } from '@lingui/react/macro'
import { Fingerprint, Loader2 } from 'lucide-react'
import { OnboardingStepHeader } from './onboarding-step-header'
import { useOnboardingPasskeyStepState } from './use-onboarding-passkey-step-state'

/**
 * Onboarding passkey step — offers to create the account's passkey right after
 * first sign-in. Sign-in only for now: no AK exists at onboarding, so the passkey
 * can unlock sync only once sync setup enrolls it. Skippable via the wizard's Skip
 * button; the dialog auto-advances past it when passkeys are unavailable or the
 * account already has its passkey.
 */
export const OnboardingPasskeyStep = () => {
  const { status, register } = useOnboardingPasskeyStepState()

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<Fingerprint className="size-10 text-primary" />}
        title={<Trans>Sign in faster next time</Trans>}
        description={
          <Trans>
            Use your fingerprint, face, or device PIN to sign in instead of an email code. Email sign-in still works
            too.
          </Trans>
        }
      />

      <div className="mt-10 flex flex-col items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="w-full rounded-xl"
          disabled={status === 'registering'}
          onClick={register}
        >
          {status === 'registering' ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Fingerprint className="mr-2 h-4 w-4" />
          )}
          <Trans>Set up a passkey</Trans>
        </Button>

        {status === 'error' && (
          <p className="text-sm text-destructive">
            <Trans>Couldn&apos;t add a passkey. You can add one later when you set up sync.</Trans>
          </p>
        )}
      </div>
    </div>
  )
}
