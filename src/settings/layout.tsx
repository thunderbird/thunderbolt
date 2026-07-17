/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Header } from '@/components/ui/header'
import { SidebarInset } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { isDesktop, isTauri } from '@/lib/platform'
import { PageFallback } from '@/loading'
import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'

// Sub-routes that provide their own mobile page chrome (burger + title row).
// On mobile the Header would only duplicate that chrome, so it's skipped; on
// desktop it still renders so the theme/sync controls stay in the top-right.
// A Tauri desktop window narrowed into the mobile layout keeps the Header
// regardless: it doubles as the window drag region and clears the macOS
// traffic lights, which the page's own chrome doesn't account for.
const routesWithOwnMobileHeader = new Set(['/settings/skills'])

const SettingsLayout = () => {
  const location = useLocation()
  const { isMobile } = useIsMobile()
  // Universal header: settings shows the same bar as chat so the theme and
  // sync controls stay in the top-right everywhere (on mobile it also carries
  // the sidebar burger).
  const showHeader = !isMobile || (isTauri() && isDesktop()) || !routesWithOwnMobileHeader.has(location.pathname)

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
          {showHeader && <Header />}
          <div
            className="flex-1 overflow-auto"
            style={{
              paddingBottom: 'var(--safe-area-bottom-padding)',
            }}
          >
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </SidebarInset>
    </>
  )
}

export default SettingsLayout
