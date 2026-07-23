/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type DetailSectionProps = ComponentProps<'section'> & {
  label: ReactNode
}

export const DetailSection = ({ label, className, children, ...props }: DetailSectionProps) => (
  <section className={cn('flex flex-col gap-1', className)} {...props}>
    <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
    {children}
  </section>
)
