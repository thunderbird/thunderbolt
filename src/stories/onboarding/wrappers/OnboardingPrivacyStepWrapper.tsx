/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingPrivacyStep } from '@/components/onboarding/onboarding-privacy-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { OnboardingState } from '@/hooks/use-onboarding-state'

export const OnboardingPrivacyStepWrapper = () => {
  const mockState: OnboardingState = {
    currentStep: 1 as const,
    privacyAgreed: false,
    isProviderConnected: false,
    isConnecting: false,
    processingOAuth: false,
    nameValue: '',
    isNameValid: false,
    isSubmittingName: false,
    locationValue: '',
    isLocationValid: false,
    isSubmittingLocation: false,
    canGoBack: false,
    canGoNext: false,
    canSkip: false,
  }

  const mockActions = {
    setPrivacyAgreed: (agreed: boolean) => console.log('setPrivacyAgreed:', agreed),
    nextStep: async () => console.log('nextStep'),
    prevStep: async () => console.log('prevStep'),
    skipStep: async () => console.log('skipStep'),
  }

  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: <OnboardingPrivacyStep state={mockState} actions={mockActions} />,
      })}
    </div>
  )
}
