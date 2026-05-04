/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Outlet } from 'react-router'

/**
 * Full-screen layout for waitlist pages.
 * Dark background, centered content with safe area handling for mobile.
 */
export const WaitlistLayout = () => {
  return (
    <div
      className="flex h-dvh w-full flex-col items-center justify-center overflow-hidden bg-background"
      style={{
        paddingTop: 'var(--safe-area-top-padding)',
        paddingBottom: 'calc(var(--safe-area-bottom-padding) + var(--kb, 0px))',
      }}
    >
      <Outlet />
    </div>
  )
}

export default WaitlistLayout
