/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const Skeleton = ({ className, ...props }: ComponentProps<'div'>) => {
  return <div data-slot="skeleton" className={cn('bg-accent animate-pulse rounded-md', className)} {...props} />
}

export { Skeleton }
