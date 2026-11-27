/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** Centered "no matches" note shown when a settings-page search filters everything out. */
export const SettingsNoResults = ({ className, ...props }: ComponentProps<'p'>) => (
  <p
    className={cn('flex min-h-32 items-center justify-center text-center text-sm text-muted-foreground', className)}
    {...props}
  />
)
