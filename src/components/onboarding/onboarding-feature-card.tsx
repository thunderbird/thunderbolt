/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { type LucideIcon } from 'lucide-react'

type OnboardingFeatureCardProps = {
  className?: string
  icon: LucideIcon
  title: string
  description: string
  iconClassName?: string
}

export const OnboardingFeatureCard = ({
  className,
  icon: Icon,
  title,
  description,
  iconClassName,
}: OnboardingFeatureCardProps) => {
  return (
    <div className={cn('flex items-center gap-4 p-4 rounded-lg bg-muted/50', className)}>
      <Icon className={`w-6 h-6 flex-shrink-0 ${iconClassName || ''}`} />
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
