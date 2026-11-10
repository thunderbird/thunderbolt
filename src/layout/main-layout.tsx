/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DownloadAppBannerDesktop } from '@/components/download-app-banner-desktop'
import { DownloadAppBannerMobile } from '@/components/download-app-banner-mobile'
import { FloatingHeader } from '@/components/floating-header'
import { useIsMobile, useIsNativeMobile } from '@/hooks/use-mobile'
import { edgeSpacing } from '@/lib/constants'
import { isTauri, isTauriDesktop } from '@/lib/platform'
import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'
import { PageFallback } from '@/loading'
import { sharedHeaderHasControls } from './shared-header'

/** Chat and Mini App route chrome inside the persistent app/browser split. */
export default function Page() {
  const { pathname } = useLocation()
  const { isMobile } = useIsMobile()
  const isNativeMobile = useIsNativeMobile()
  const showsSharedHeader = sharedHeaderHasControls({ pathname, isMobile, isDesktopApp: isTauriDesktop() })

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Wherever it has something to show — see `sharedHeaderHasControls`.
                `/apps/` was chromeless for a while, on the reasoning that a
                customer's app is the content and a bar above it duplicates the
                app's own header. That cost the whole shared toolbar:
                back/forward, the sidebar toggle, and — on frameless
                Windows/Linux — the only drag region the window had. Putting it
                back unconditionally then drew an empty bar over the app on web,
                because everything else in the header is gated on `/chats`. */}
      {showsSharedHeader && <FloatingHeader />}
      {!isTauri() && (
        <>
          <DownloadAppBannerMobile />
          <DownloadAppBannerDesktop />
        </>
      )}
      <div
        className="flex-1 overflow-auto"
        style={{
          // Reserve the home-indicator safe area, but don't double-count it
          // with the on-screen keyboard: when the keyboard is open (`--kb` > 0)
          // it already covers that region, so subtract it. Without this, the
          // safe-area inset stacks on top of `chat-ui`'s `var(--kb)` and shoves
          // a bottom-anchored input well above the keyboard (THU-586). At rest
          // (`--kb` = 0) this is the full safe-area inset. Native mobile keeps
          // at least the standard 12px edge spacing when the inset is smaller.
          paddingBottom: isNativeMobile
            ? `max(var(--safe-area-bottom-padding) - var(--kb, 0px), ${edgeSpacing.mobile}px)`
            : 'max(var(--safe-area-bottom-padding) - var(--kb, 0px), 0px)',
        }}
      >
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  )
}
