/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnboardingAuthStep } from '@/components/onboarding/onboarding-auth-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { MemoryRouter } from 'react-router'

export const OnboardingAuthStepWrapper = () => {
  const handleConnectionChange = (connected: boolean) => {
    console.log('Connection changed:', connected)
  }

  return (
    <MemoryRouter>
      <div className="w-[400px] h-[500px] border rounded-lg p-4">
        {createQueryTestWrapper()({
          children: (
            <OnboardingAuthStep
              providers={['google']}
              isProcessing={false}
              isConnected={false}
              onConnectionChange={handleConnectionChange}
            />
          ),
        })}
      </div>
    </MemoryRouter>
  )
}
