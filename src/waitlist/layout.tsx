/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthScreenFrame } from '@/components/auth-screen'
import { PageFallback } from '@/loading'
import { Suspense } from 'react'
import { Outlet } from 'react-router'

/**
 * Full-screen layout for waitlist pages.
 */
export const WaitlistLayout = () => {
  return (
    <AuthScreenFrame>
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </AuthScreenFrame>
  )
}

export default WaitlistLayout
