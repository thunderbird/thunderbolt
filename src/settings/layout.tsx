/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FloatingHeader } from '@/components/floating-header'
import { SidebarInset } from '@/components/ui/sidebar'
import { PageFallback } from '@/loading'
import { Suspense, type CSSProperties } from 'react'
import { Outlet } from 'react-router'

const SettingsLayout = () => {
  // Universal header: settings shows the same floating bar as chat (on mobile
  // it also carries the sidebar burger). The header overlays the content and a
  // top scrim keeps its controls legible while pages scroll beneath it; the
  // page shells own the resting header inset, leaving this viewport edge open
  // so their scrolling content can pass beneath the scrim instead of clipping.
  return (
    <>
      <SidebarInset className="h-full overflow-hidden flex flex-col">
        <div
          className="relative flex flex-col h-full"
          style={
            {
              paddingBottom: 'var(--kb, 0px)',
              '--page-create-action-clearance-inset': 'max(var(--safe-area-bottom-padding) - var(--kb, 0px), 0px)',
            } as CSSProperties
          }
        >
          <FloatingHeader />
          <div className="flex-1 overflow-auto md:pt-[var(--header-inset)]">
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
