/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingCelebrationStep } from '@/components/onboarding/onboarding-celebration-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useState } from 'react'

export const OnboardingCelebrationStepWrapper = () => {
  const [donateUsageData, setDonateUsageData] = useState(true)
  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: (
          <OnboardingCelebrationStep
            donateUsageData={donateUsageData}
            onDonationChange={setDonateUsageData}
            donationDisabled={false}
          />
        ),
      })}
    </div>
  )
}
