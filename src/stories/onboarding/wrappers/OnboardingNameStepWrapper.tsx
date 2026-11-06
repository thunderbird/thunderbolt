/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingNameStep } from '@/components/onboarding/onboarding-name-step'
import { useState } from 'react'

export const OnboardingNameStepWrapper = () => {
  const [nameValue, setNameValue] = useState('')

  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      <OnboardingNameStep state={{ nameValue, isSubmittingName: false }} actions={{ setNameValue }} />
    </div>
  )
}
