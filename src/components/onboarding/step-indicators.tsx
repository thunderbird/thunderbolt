/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CSSProperties } from 'react'

type StepIndicatorsProps = {
  currentStep: number
  totalSteps: number
}

/**
 * Samples one virtual gradient across every indicator and its equal-width gap.
 */
const getCompletedIndicatorStyle = (index: number, totalSteps: number): CSSProperties => ({
  backgroundImage: 'var(--gradient-brand)',
  backgroundPosition: `${totalSteps === 1 ? 50 : (index / (totalSteps - 1)) * 100}% center`,
  backgroundSize: `${(totalSteps * 2 - 1) * 100}% 100%`,
})

export const StepIndicators = ({ currentStep, totalSteps }: StepIndicatorsProps) => {
  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: totalSteps }, (_, index) => {
        const isCompleted = currentStep >= index + 1

        return (
          <div
            key={index}
            className={`h-2 w-2 rounded-full ${isCompleted ? 'bg-brand' : 'bg-muted'}`}
            style={isCompleted ? getCompletedIndicatorStyle(index, totalSteps) : undefined}
          />
        )
      })}
    </div>
  )
}
