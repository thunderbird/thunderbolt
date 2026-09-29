/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts'
import { getDeviceDisplayName } from '@/lib/platform'
import { isPasskeyCancellation, registerPasskey } from '@/lib/passkey'
import { Trans, useLingui } from '@lingui/react/macro'
import { CheckCircle2, Fingerprint, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { OnboardingStepHeader } from './onboarding-step-header'

type Status = 'idle' | 'registering' | 'done' | 'error'

/**
 * Onboarding passkey step (THU-790 POC) — offers sign-in passkey enrolment right
 * after first sign-in. Sign-in only: no AK exists at onboarding, so this never
 * touches E2EE. Skippable via the wizard's Skip button; the dialog auto-advances
 * past it when passkeys are unavailable for this runtime/deployment.
 */
export const OnboardingPasskeyStep = () => {
  const { t } = useLingui()
  const authClient = useAuth()
  const [status, setStatus] = useState<Status>('idle')

  const handleRegister = async () => {
    setStatus('registering')
    try {
      await registerPasskey(authClient, getDeviceDisplayName())
      setStatus('done')
    } catch (error) {
      if (isPasskeyCancellation(error)) {
        setStatus('idle')
        return
      }
      console.error('Passkey registration failed:', error)
      setStatus('error')
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<Fingerprint className="size-10 text-primary" />}
        title={<Trans>Sign in faster next time</Trans>}
        description={
          <Trans>
            Add a passkey to sign in with your fingerprint, face, or device PIN instead of an email code. You can always
            use your email too.
          </Trans>
        }
      />

      <div className="mt-10 flex flex-col items-center gap-3">
        {status === 'done' ? (
          <div className="flex items-center gap-2 text-[length:var(--font-size-body)] text-primary">
            <CheckCircle2 className="size-5" />
            <Trans>Passkey added — you&apos;re all set.</Trans>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full rounded-xl"
            disabled={status === 'registering'}
            onClick={handleRegister}
          >
            {status === 'registering' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="mr-2 h-4 w-4" />
            )}
            <Trans>Set up a passkey</Trans>
          </Button>
        )}

        {status === 'error' && (
          <p className="text-sm text-destructive">{t`Couldn't add a passkey. You can try again from Settings later.`}</p>
        )}
      </div>
    </div>
  )
}
