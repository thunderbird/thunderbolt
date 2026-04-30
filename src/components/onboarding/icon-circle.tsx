/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react'

type IconCircleProps = {
  children: ReactNode
  size?: number
}

/**
 * Reusable icon circle for onboarding steps
 */
export const IconCircle = ({ children, size = 16 }: IconCircleProps) => {
  return (
    <div
      className={`mx-auto bg-white dark:bg-gray-800 rounded-full flex items-center justify-center shadow-sm border`}
      style={{ width: `${size * 4}px`, height: `${size * 4}px` }}
    >
      {children}
    </div>
  )
}
