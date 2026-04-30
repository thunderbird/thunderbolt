/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'

type OnboardingActionButtonsProps = {
  onBack?: () => void
  onSkip?: () => void
  onContinue: () => void
  showBack?: boolean
  showSkip?: boolean
  showContinue?: boolean
  continueText?: string
  continueDisabled?: boolean
  skipDisabled?: boolean
}

export const OnboardingActionButtons = ({
  onBack,
  onSkip,
  onContinue,
  showBack = true,
  showSkip = true,
  showContinue = true,
  continueText = 'Continue',
  continueDisabled = false,
  skipDisabled = false,
}: OnboardingActionButtonsProps) => {
  return (
    <div className="flex flex-1 w-full justify-between">
      <div>
        {showBack && onBack && (
          <Button onClick={onBack} variant="ghost" className="justify-center">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className={`flex space-x-2 ${!showBack && !showSkip && 'w-full'}`}>
        {showSkip && onSkip && (
          <Button onClick={onSkip} variant="ghost" disabled={skipDisabled}>
            Skip
          </Button>
        )}
        {showContinue && onContinue && (
          <Button onClick={onContinue} disabled={continueDisabled} className={`${!showBack && !showSkip && 'w-full'}`}>
            {continueText}
          </Button>
        )}
      </div>
    </div>
  )
}
