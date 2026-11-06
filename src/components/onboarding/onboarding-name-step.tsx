/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Input } from '@/components/ui/input'
import { User } from 'lucide-react'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { OnboardingStepHeader } from './onboarding-step-header'

type OnboardingNameStepProps = {
  state: Pick<OnboardingState, 'nameValue'>
  actions: { setNameValue: (value: string) => void }
}

export const OnboardingNameStep = ({ state, actions }: OnboardingNameStepProps) => {
  const { t } = useLingui()
  return (
    <div className="flex w-full flex-1 flex-col justify-center">
      <OnboardingStepHeader
        icon={<User className="size-10 text-primary" />}
        title={<Trans>What should we call you?</Trans>}
        description={<Trans>Your AI assistant will use this name to address you personally.</Trans>}
      />
      <div className="mt-10">
        <Input
          name="preferredName"
          aria-label={t`Name`}
          placeholder={t`Enter your name`}
          value={state.nameValue}
          onChange={(event) => actions.setNameValue(event.target.value)}
          autoFocus
          autoComplete="off"
        />
      </div>
    </div>
  )
}
