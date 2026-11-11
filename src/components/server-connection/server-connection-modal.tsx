/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { OnboardingServerStep } from '@/components/onboarding/onboarding-server-step'
import { useOnboardingServerState } from '@/components/onboarding/use-onboarding-server-state'
import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { connectionModalSurfaceClass } from '@/components/ui/modal-styles'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'

type ServerConnectionModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  onAuthenticated?: () => void
}

const ServerConnectionContent = ({
  onOpenChange,
  onConnected,
  onAuthenticated,
}: Omit<ServerConnectionModalProps, 'open'>) => {
  const state = useOnboardingServerState(undefined, {
    initialSelection: 'cloud',
    onSignInSuccess: onAuthenticated ?? (() => onOpenChange(false)),
  })
  return (
    <>
      <ResponsiveModalHeader className="sr-only">
        <ResponsiveModalTitle>
          <Trans>Connect to Thunderbolt</Trans>
        </ResponsiveModalTitle>
        <ResponsiveModalDescription>
          <Trans>Choose Cloud or Enterprise to connect your account.</Trans>
        </ResponsiveModalDescription>
      </ResponsiveModalHeader>
      <ResponsiveModalContent centered className="min-h-0">
        <OnboardingServerStep
          serverState={state}
          allowLocal={false}
          onSignIn={() => onConnected?.()}
          onContinueLocal={() => onOpenChange(false)}
        />
      </ResponsiveModalContent>
      <div className="flex shrink-0 items-center justify-between pt-2">
        {!state.isChoosingSetup ? <BackButton onClick={state.goBack} disabled={state.isBusy} /> : <span />}
        {state.isChoosingSetup && (
          <Button onClick={() => state.continueSetup(() => {})} disabled={state.isBusy} aria-busy={state.isBusy}>
            <Trans>Continue</Trans>
          </Button>
        )}
      </div>
    </>
  )
}

/** Reuses onboarding's Cloud/waitlist and Enterprise paths for local cloud entry points. */
export const ServerConnectionModal = ({ open, ...props }: ServerConnectionModalProps) => (
  <ResponsiveModal open={open} onOpenChange={props.onOpenChange} className={connectionModalSurfaceClass}>
    {open && <ServerConnectionContent {...props} />}
  </ResponsiveModal>
)
