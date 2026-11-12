/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'
import { Switch } from '@/components/ui/switch'
import { useAppName } from '@/lib/branding-selectors'
import { Trans } from '@lingui/react/macro'
import { OnboardingStepHeader } from './onboarding-step-header'

type OnboardingCelebrationStepProps = {
  donateUsageData: boolean
  onDonationChange: (enabled: boolean) => void
  donationDisabled: boolean
}

export const OnboardingCelebrationStep = ({
  donateUsageData,
  onDonationChange,
  donationDisabled,
}: OnboardingCelebrationStepProps) => {
  const appName = useAppName()
  return (
    <div className="flex h-full w-full flex-col justify-center">
      <OnboardingStepHeader
        icon={<GradientCircleCheck className="size-12" />}
        title={<Trans>You're all set! 🎉</Trans>}
        description={<Trans>Help make {appName} better.</Trans>}
      />
      <div className="mt-8 flex items-center gap-6 rounded-xl bg-muted p-6">
        <div className="flex-1 space-y-2">
          <label htmlFor="onboarding-data-donation" className="text-base font-medium text-foreground/80">
            <Trans>Donate anonymous usage data</Trans>
          </label>
          <p id="onboarding-data-donation-description" className="text-sm text-muted-foreground">
            <Trans>Your donation helps us understand how the app is used and improve the product.</Trans>
          </p>
        </div>
        <Switch
          id="onboarding-data-donation"
          checked={donateUsageData}
          onCheckedChange={onDonationChange}
          disabled={donationDisabled}
          aria-describedby="onboarding-data-donation-description"
        />
      </div>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        <Trans>It's optional. You can turn this off now or change it later in Settings.</Trans>
      </p>
    </div>
  )
}
