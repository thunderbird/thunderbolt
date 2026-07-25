/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FloatingHeader } from '@/components/floating-header'
import { SidebarInset } from '@/components/ui/sidebar'
import { PageFallback } from '@/loading'
import { Suspense } from 'react'
import { Outlet } from 'react-router'

const SettingsLayout = () => {
  // Universal header: settings shows the same floating bar as chat (on mobile
  // it also carries the sidebar burger). The header overlays the content and a
  // top scrim keeps its controls legible while pages scroll beneath it; the
  // scroll container pads by --header-inset so content starts below the bar
  // at rest but clips at the viewport top once scrolled.
  return (
    <>
      <SidebarInset className="h-full overflow-hidden flex flex-col">
        <div
          className="relative flex flex-col h-full"
          style={{
            paddingBottom: 'var(--kb, 0px)',
          }}
        >
          <FloatingHeader />
          <div
            className="flex-1 overflow-auto"
            style={{
              paddingTop: 'var(--header-inset)',
              // The wrapper above already gave up `--kb` to the keyboard, which
              // covers the home indicator too — so don't reserve that inset a
              // second time inside the scroller (THU-586).
              paddingBottom: 'max(var(--safe-area-bottom-padding) - var(--kb, 0px), 0px)',
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
