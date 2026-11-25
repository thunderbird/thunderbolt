/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Ref } from 'react'

import { Button } from '@/components/ui/button'
import { useFormatters } from '@/i18n/use-formatters'

type AskStepControlProps = {
  /** Id of the "Question N of M" label, which describes the prompt. */
  labelId: string
  /** 1-based. */
  step: number
  total: number
  /** Omitted when there is no step to go back to. */
  onPrevious?: () => void
  /** Omitted until the current step is answered, and on the last step. */
  onNext?: () => void
  /** The › button, which takes focus once a graded answer locks the step. */
  nextRef?: Ref<HTMLButtonElement>
}

/** `‹ Question N of M ›` in a sequence step's header: the step label and the way back and forth. */
export const AskStepControl = ({ labelId, step, total, onPrevious, onNext, nextRef }: AskStepControlProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const currentStep = formatters.number(step)
  const totalSteps = formatters.number(total)

  return (
    <div className="ml-auto flex items-center gap-1 normal-case tracking-normal">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Previous question`}
        disabled={!onPrevious}
        onClick={onPrevious}
      >
        <ChevronLeft />
      </Button>
      <span id={labelId}>
        <Trans>
          Question {currentStep} of {totalSteps}
        </Trans>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        ref={nextRef}
        aria-label={t`Next question`}
        disabled={!onNext}
        onClick={onNext}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}
