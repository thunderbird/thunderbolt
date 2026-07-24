/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

/** Surface-neutral footer that stays at the bottom of a flex form. */
export const FormFooter = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="form-footer"
    className={cn('mt-auto flex shrink-0 flex-row justify-end gap-2 pt-4', className)}
    {...props}
  />
)
