/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingCelebrationStep } from '@/components/onboarding/onboarding-celebration-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'

export const OnboardingCelebrationStepWrapper = () => {
  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      {createQueryTestWrapper()({
        children: <OnboardingCelebrationStep />,
      })}
    </div>
  )
}
