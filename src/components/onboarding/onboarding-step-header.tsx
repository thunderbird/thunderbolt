/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

type OnboardingStepHeaderProps = {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
}

export const OnboardingStepHeader = ({ icon, title, description }: OnboardingStepHeaderProps) => {
  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex justify-center">{icon}</div>
      <h2 className="font-heading text-2xl">{title}</h2>
      {description && (
        <p className="mt-1 px-4 text-[length:var(--font-size-sm)] text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
