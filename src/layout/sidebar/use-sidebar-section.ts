/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import type { SidebarSection } from './types'

/**
 * Resolves which sidebar section (Chats vs Settings) is visible.
 *
 * Normally derived from the route (`/settings/*` → settings). The nav toggle
 * can override this without navigating — the current page stays until the
 * user picks an entry from the new sidebar. The override is keyed to the
 * pathname it was set on, so any navigation invalidates it and the section
 * falls back to being derived from the route.
 */
export const useSidebarSection = (pathname: string) => {
  const [override, setOverride] = useState<{ section: SidebarSection; pathname: string } | null>(null)

  const routeSection: SidebarSection = pathname.startsWith('/settings') ? 'settings' : 'chats'
  const activeSection = override?.pathname === pathname ? override.section : routeSection

  const setActiveSection = (section: SidebarSection) => {
    setOverride(section === routeSection ? null : { section, pathname })
  }

  return { activeSection, setActiveSection }
}
