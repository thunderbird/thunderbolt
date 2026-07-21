/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type LucideIcon } from 'lucide-react'

type OnboardingFeatureCardProps = {
  icon: LucideIcon
  title: string
  description: string
}

export const OnboardingFeatureCard = ({ icon: Icon, title, description }: OnboardingFeatureCardProps) => {
  return (
    <div className="flex items-center gap-4 p-4">
      <Icon className="size-6 shrink-0" />
      <div>
        <h3 className="text-[length:var(--font-size-sm)] font-medium">{title}</h3>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
