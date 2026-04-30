/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type StepIndicatorsProps = {
  currentStep: number
  totalSteps: number
}

export const StepIndicators = ({ currentStep, totalSteps }: StepIndicatorsProps) => {
  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: totalSteps }, (_, index) => (
        <div key={index} className={`h-2 w-2 rounded-full ${currentStep >= index + 1 ? 'bg-primary' : 'bg-muted'}`} />
      ))}
    </div>
  )
}
