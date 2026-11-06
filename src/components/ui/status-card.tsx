/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { forwardRef, type ComponentProps, type ReactNode } from 'react'

type StatusCardProps = Omit<ComponentProps<typeof Card>, 'title'> & {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
}

const StatusCard = forwardRef<HTMLDivElement, StatusCardProps>(
  ({ icon, title, description, children, className, ...props }, ref) => {
    return (
      <Card ref={ref} className={cn('gap-0 rounded-xl border border-border py-0 shadow-sm', className)} {...props}>
        <CardContent className="px-4 py-3">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            {icon}
            <span>{title}</span>
          </div>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
          {children}
        </CardContent>
      </Card>
    )
  },
)

StatusCard.displayName = 'StatusCard'

export { StatusCard }
