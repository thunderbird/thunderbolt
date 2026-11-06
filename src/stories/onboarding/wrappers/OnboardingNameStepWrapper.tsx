/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { OnboardingNameStep } from '@/components/onboarding/onboarding-name-step'

export const OnboardingNameStepWrapper = () => {
  const [nameValue, setNameValue] = useState('')
  return (
    <div className="w-[400px] h-[500px] border rounded-lg p-4">
      <OnboardingNameStep state={{ nameValue }} actions={{ setNameValue }} />
    </div>
  )
}
