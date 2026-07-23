/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type SettingsEmptyStateProps = ComponentProps<'div'> & {
  icon?: ReactNode
  title?: ReactNode
  description: ReactNode
  action?: ReactNode
}

export const SettingsEmptyState = ({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: SettingsEmptyStateProps) => (
  <div
    className={cn(
      'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/25 px-6 py-10 text-center',
      className,
    )}
    {...props}
  >
    {icon}
    <div className="max-w-md">
      {title && <h3 className="font-medium text-foreground">{title}</h3>}
      <div className={cn('text-sm text-muted-foreground', title && 'mt-1')}>{description}</div>
    </div>
    {action}
  </div>
)

export const SettingsNoResults = ({ className, ...props }: ComponentProps<'p'>) => (
  <p
    className={cn('flex min-h-32 items-center justify-center text-center text-sm text-muted-foreground', className)}
    {...props}
  />
)
