/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { Card, CardContent } from './card'

type SectionCardProps = {
  title: string
  children: ReactNode
  className?: string
}

export const SectionCard = ({ title, children, className }: SectionCardProps) => {
  return (
    <>
      <h3 className="text-lg font-semibold -mb-2">{title}</h3>
      <Card className={className}>
        <CardContent>{children}</CardContent>
      </Card>
    </>
  )
}
