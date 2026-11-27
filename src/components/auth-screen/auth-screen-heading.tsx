/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

type AuthScreenHeadingProps = {
  title: ReactNode
  description?: ReactNode
}

/** Title and optional description of an auth screen, in the waitlist's type scale. */
export const AuthScreenHeading = ({ title, description }: AuthScreenHeadingProps) => (
  <div className="flex flex-col items-center gap-2 text-center">
    <h1 className="font-sans text-[28px] font-medium leading-normal text-foreground">{title}</h1>
    {description && <p className="text-base text-muted-foreground">{description}</p>}
  </div>
)
