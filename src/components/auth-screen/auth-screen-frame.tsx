/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

/**
 * Full-screen backdrop for the standalone auth screens.
 * Centered content with safe area handling for mobile.
 */
export const AuthScreenFrame = ({ children }: { children: ReactNode }) => (
  <div
    className="flex h-dvh w-full flex-col items-center justify-center overflow-hidden bg-background"
    style={{
      paddingTop: 'var(--safe-area-top-padding)',
      paddingBottom: 'calc(var(--safe-area-bottom-padding) + var(--kb, 0px))',
    }}
  >
    {children}
  </div>
)
