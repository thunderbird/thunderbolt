/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

/** A compact browser control with matching visible and accessible labels. */
export const BrowserToolbarButton = ({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'variant'> & { label: string }) => (
  <Button
    variant="ghost"
    size="icon"
    className={cn('size-8 shrink-0 cursor-pointer rounded-xl', className)}
    title={label}
    aria-label={label}
    {...props}
  />
)
