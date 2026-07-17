/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile } from '@/hooks/use-mobile'
import { isMacDesktop } from '@/lib/platform'

/**
 * SafeAreaView-style clearance for the macOS window controls (the traffic
 * lights, which end at ~x=68 and are OS-drawn over our frameless window).
 *
 * Returns true when a full-window surface's top-left corner sits under them:
 * the Tauri macOS app at mobile (single-column) width, where overlays and
 * panels cover the whole window. At desktop widths the sidebar/header strips
 * already carry the clearance, and Windows/Linux never need any —
 * `WindowChrome` reserves a dedicated top strip for its custom controls.
 *
 * Consumers pad their header row by `pl-20` (80px, the same clearance the
 * main `Header` and the sidebar strips use) when this is true.
 */
export const useMacWindowControlsClearance = (): boolean => {
  const { isMobile } = useIsMobile()
  return isMacDesktop() && isMobile
}
