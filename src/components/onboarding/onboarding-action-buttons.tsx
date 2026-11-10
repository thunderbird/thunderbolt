/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

type OnboardingActionButtonsProps = {
  onBack?: () => void
  onSkip?: () => void
  onContinue: () => void
  showBack?: boolean
  showSkip?: boolean
  showContinue?: boolean
  continueText?: ReactNode
  backDisabled?: boolean
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
  continueText = <Trans>Continue</Trans>,
  backDisabled = false,
  continueDisabled = false,
  skipDisabled = false,
}: OnboardingActionButtonsProps) => {
  const { t } = useLingui()
  return (
    <div className="flex flex-1 w-full justify-between">
      <div>
        {showBack && onBack && (
          <Button onClick={onBack} variant="ghost" size="icon" aria-label={t`Back`} disabled={backDisabled}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className={`flex space-x-2 ${!showBack && !showSkip && 'w-full'}`}>
        {showSkip && onSkip && (
          <Button
            onClick={onSkip}
            variant="ghost"
            disabled={skipDisabled}
            className="font-normal text-muted-foreground"
          >
            <Trans>Skip</Trans>
          </Button>
        )}
        {showContinue && onContinue && (
          <Button
            onClick={onContinue}
            disabled={continueDisabled}
            className={!showBack && !showSkip ? 'w-full' : undefined}
          >
            {continueText}
          </Button>
        )}
      </div>
    </div>
  )
}
