/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { DetailSectionTitle } from '@/components/detail-panel'
import { cn } from '@/lib/utils'

type DetailFieldProps = ComponentProps<'section'> & {
  label: ReactNode
}

/** A labeled value block for detail panels, using the shared section-title style. */
export const DetailField = ({ label, className, children, ...props }: DetailFieldProps) => (
  <section className={cn('flex flex-col gap-1', className)} {...props}>
    <DetailSectionTitle>{label}</DetailSectionTitle>
    {children}
  </section>
)
