/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { IconCircle } from '@/components/onboarding/icon-circle'
import { SignInOtpStep } from '@/components/sign-in/sign-in-otp-step'
import { Button } from '@/components/ui/button'
import { isLocalhostUrl } from '@/lib/utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { Fingerprint } from 'lucide-react'
import { useConfirmIdentityState } from './use-confirm-identity-state'

type ConfirmIdentityStepProps = {
  /** The user entered a valid code, so the session is recent again. */
  onConfirmed: () => void
  onSkip: () => void
}

/**
 * Shown when adding a passkey needs a recent sign-in. The user confirms with an
 * emailed code right here, without leaving sync setup or signing out.
 */
export const ConfirmIdentityStep = ({ onConfirmed, onSkip }: ConfirmIdentityStepProps) => {
  const { t } = useLingui()
  const { email, state, actions } = useConfirmIdentityState({ onConfirmed })
  const isLocalhost = isLocalhostUrl(useLocalSettingsStore((s) => s.cloudUrl))

  if (state.status === 'sent' || state.status === 'verifying') {
    return (
      <SignInOtpStep
        email={email}
        otp={state.otp}
        status={state.status}
        errorMessage={state.errorMessage}
        isLocalhost={isLocalhost}
        onOtpChange={actions.setOtp}
        onOtpComplete={actions.verify}
        onResend={actions.resend}
        onCancel={actions.cancel}
        variant="modal"
        showMagicLinkHint={false}
      />
    )
  }

  return (
    <div className="w-full flex flex-col">
      <div className="text-center space-y-4">
        <IconCircle>
          <Fingerprint className="size-8 text-primary" />
        </IconCircle>
        <h2 className="text-2xl font-bold">
          <Trans>Create passkey</Trans>
        </h2>
        <p className="text-muted-foreground">
          <Trans>To continue, we’ll email you a verification code.</Trans>
        </p>
      </div>

      <div className="pt-5 space-y-4">
        {state.errorMessage && <p className="text-sm text-destructive">{state.errorMessage}</p>}
        <Button
          className="w-full"
          onClick={actions.sendCode}
          isLoading={state.status === 'sending'}
          loadingLabel={t`Sending code…`}
        >
          <Trans>Send code</Trans>
        </Button>
        <Button variant="ghost" className="w-full" onClick={onSkip} disabled={state.status === 'sending'}>
          <Trans>Not now</Trans>
        </Button>
      </div>
    </div>
  )
}
