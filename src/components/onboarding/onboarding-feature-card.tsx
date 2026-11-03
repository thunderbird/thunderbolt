/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type OnboardingFeatureCardProps = {
  icon: LucideIcon
  // ReactNode, like OnboardingStepHeader, so callers pass <Trans> rather than
  // needing useLingui() to produce a string.
  title: ReactNode
  description: ReactNode
  className?: string
}

export const OnboardingFeatureCard = ({ icon: Icon, title, description, className }: OnboardingFeatureCardProps) => {
  return (
    <div className={cn('flex items-center gap-4 p-4', className)}>
      <Icon className="size-6 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        <h3 className="text-[length:var(--font-size-body)] font-medium">{title}</h3>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
