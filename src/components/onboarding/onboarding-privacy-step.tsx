/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Checkbox } from '@/components/ui/checkbox'
import type { OnboardingState } from '@/hooks/use-onboarding-state'
import { privacyPolicyUrl, termsOfServiceUrl } from '@/lib/constants'
import { Database, EyeOff, ServerOff } from 'lucide-react'
import { OnboardingFeatureCard } from './onboarding-feature-card'
import { OnboardingStepHeader } from './onboarding-step-header'

type OnboardingPrivacyStepProps = {
  state: OnboardingState
  actions: {
    setPrivacyAgreed: (agreed: boolean) => void
    nextStep: () => Promise<void>
    prevStep: () => Promise<void>
    skipStep: () => Promise<void>
  }
}

export const OnboardingPrivacyStep = ({ state, actions }: OnboardingPrivacyStepProps) => {
  const handleAgreementChange = (checked: boolean) => {
    actions.setPrivacyAgreed(checked)
  }

  return (
    <div className="w-full flex flex-1 flex-col">
      <div className="flex flex-1 flex-col justify-center">
        <OnboardingStepHeader
          icon={<AppLogo size={72} />}
          title="Welcome to Thunderbolt!"
          description="Your private AI assistant"
        />

        <div className="mt-10 rounded-xl bg-muted">
          <OnboardingFeatureCard
            icon={ServerOff}
            title="Zero Logs"
            description="We don't keep logs of your conversations."
          />

          <OnboardingFeatureCard
            icon={EyeOff}
            title="Zero Training"
            description="We don't train models on your data."
          />

          <OnboardingFeatureCard
            icon={Database}
            title="Local Storage"
            description="Data is stored securely on your device."
          />
        </div>
      </div>

      <div>
        <div className="flex items-center gap-3 pl-1">
          <Checkbox
            id="terms-agreement"
            checked={state.privacyAgreed}
            onCheckedChange={(checked) => handleAgreementChange(checked === true)}
            className="scale-130 cursor-pointer"
          />
          <label htmlFor="terms-agreement" className="text-base text-muted-foreground leading-relaxed cursor-pointer">
            I agree to the{' '}
            <a
              href={privacyPolicyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline font-medium"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href={termsOfServiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline font-medium"
            >
              Terms of Service
            </a>
            .
          </label>
        </div>
      </div>
    </div>
  )
}
