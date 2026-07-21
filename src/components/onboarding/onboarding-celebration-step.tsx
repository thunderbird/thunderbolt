/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GradientCircleCheck } from '@/components/ui/gradient-circle-check'

export const OnboardingCelebrationStep = () => {
  return (
    <div className="w-full h-full flex flex-col justify-center">
      <div className="space-y-6">
        <div className="space-y-4 text-center">
          <GradientCircleCheck className="mx-auto h-12 w-12" />
          <div className="space-y-2">
            <p className="text-lg text-muted-foreground">You're all set! 🎉</p>
          </div>
        </div>
      </div>
    </div>
  )
}
