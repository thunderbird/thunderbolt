/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Header } from '@/components/ui/header'
import { SidebarInset } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { Outlet, useLocation } from 'react-router'

// Pages that render their own top-bar (with hamburger toggle inline) and
// should skip the shared Header on mobile.
const customMobileHeaderRoutes = ['/settings/skills', '/marketplace']

export default function SettingsLayout() {
  const { isMobile } = useIsMobile()
  const location = useLocation()
  const hasCustomMobileHeader = customMobileHeaderRoutes.some((p) => location.pathname.startsWith(p))

  return (
    <>
      <SidebarInset className="h-full overflow-hidden flex flex-col">
        <div
          className="flex flex-col h-full"
          style={{
            paddingTop: 'var(--safe-area-top-padding)',
            paddingBottom: 'var(--kb, 0px)',
          }}
        >
          {isMobile && !hasCustomMobileHeader && <Header />}
          <div
            className="flex-1 overflow-auto"
            style={{
              paddingBottom: 'var(--safe-area-bottom-padding)',
            }}
          >
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </>
  )
}
