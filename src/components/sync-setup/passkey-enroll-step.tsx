/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { Fingerprint } from 'lucide-react'
import { ConfirmIdentityStep } from './confirm-identity-step'
import { usePasskeyEnrollState } from './use-passkey-enroll-state'

type PasskeyEnrollStepProps = {
  /** Enroll the passkey to unlock sync; false creates a sign-in-only passkey. */
  unlocksSync: boolean
  /** Leaves the step — after enrolling, after skipping, or after a passkey that can't unlock sync. */
  onDone: () => void
  /** Reports an enrollment in flight, so the modal can't be closed mid-way. */
  onBusyChange: (isBusy: boolean) => void
}

/**
 * Passkey step: turn the account's passkey into a way to unlock sync on new
 * devices, so they don't need approval from another device. With `unlocksSync`
 * off, it adds a passkey for sign-in only.
 */
export const PasskeyEnrollStep = ({ unlocksSync, onDone, onBusyChange }: PasskeyEnrollStepProps) => {
  const { hasPasskey, isLoading, status, enroll, onReauthenticated } = usePasskeyEnrollState({
    unlocksSync,
    onEnrolled: onDone,
    onBusyChange,
  })

  if (status === 'needs-reauth') {
    return <ConfirmIdentityStep onConfirmed={onReauthenticated} onSkip={onDone} />
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <IconCircle>
          <Fingerprint className="size-8 text-primary" />
        </IconCircle>
        {unlocksSync ? (
          <>
            <h2 className="text-2xl font-bold">
              <Trans>Unlock sync with a passkey</Trans>
            </h2>
            <p className="text-muted-foreground">
              <Trans>
                Turn on sync on new devices with just your passkey, no approval needed. Anyone with access to your
                passkey can unlock your data.
              </Trans>
            </p>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold">
              <Trans>Sign in faster next time</Trans>
            </h2>
            <p className="text-muted-foreground">
              <Trans>
                Use your fingerprint, face, or device PIN to sign in instead of an email code. Email sign-in still works
                too.
              </Trans>
            </p>
          </>
        )}
      </div>

      <div className="pt-5 space-y-4">
        {status === 'no-prf' && (
          <p className="text-sm text-muted-foreground">
            <Trans>
              This passkey can sign you in, but it can&apos;t unlock sync. You can still approve new devices or use your
              recovery phrase.
            </Trans>
          </p>
        )}
        {status === 'error' && (
          <p className="text-sm text-destructive">
            <Trans>Couldn&apos;t set up the passkey. Please try again.</Trans>
          </p>
        )}

        {status === 'no-prf' ? (
          <Button className="w-full" onClick={onDone}>
            <Trans>Continue</Trans>
          </Button>
        ) : (
          <>
            <Button className="w-full" onClick={enroll} isLoading={status === 'working'} disabled={isLoading}>
              {hasPasskey ? <Trans>Use passkey</Trans> : <Trans>Create passkey</Trans>}
            </Button>
            <Button variant="ghost" className="w-full" onClick={onDone} disabled={status === 'working'}>
              <Trans>Not now</Trans>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
