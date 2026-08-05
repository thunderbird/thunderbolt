/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, useState, type ReactNode } from 'react'

type MobileForegroundPortalTarget = HTMLElement | null | undefined

const MobileForegroundPortalContext = createContext<MobileForegroundPortalTarget>(undefined)

/**
 * Keeps viewport-anchored mobile page chrome inside the movable app surface.
 */
export const MobileForegroundPortalProvider = ({ children }: { children: ReactNode }) => {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)

  return (
    <MobileForegroundPortalContext value={target}>
      {children}
      <div ref={setTarget} className="contents" data-slot="mobile-foreground-portal" />
    </MobileForegroundPortalContext>
  )
}

/**
 * Resolves the mobile page-chrome portal, falling back to `body` when a
 * component is rendered outside the authenticated mobile shell.
 */
export const useMobileForegroundPortalTarget = (): HTMLElement | null => {
  const target = useContext(MobileForegroundPortalContext)
  return target !== undefined ? target : document.body
}
