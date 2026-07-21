/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WindowControls } from '@/components/window-controls'
import { isFramelessControlsPlatform } from '@/lib/platform'
import type { ReactNode } from 'react'

/**
 * App-level frameless-window chrome. On Windows/Linux Tauri desktop the main
 * window is fully undecorated, so we reserve a persistent top strip with a
 * drag region and the min/maximize/close controls. Wrapping every route
 * (including the pre-database Loading/error/upgrade screens) ensures the user
 * can always close or drag the window — before this, those screens rendered
 * outside the layouts that host the Header, leaving Alt+F4 as the only exit.
 *
 * Renders as a passthrough on macOS Tauri (OS-drawn traffic lights) and on the
 * web build (native chrome).
 */
export const WindowChrome = ({ children }: { children: ReactNode }) => {
  if (!isFramelessControlsPlatform()) {
    return <>{children}</>
  }
  return (
    <div className="flex flex-col h-full w-full">
      <div
        data-tauri-drag-region
        className="h-9 flex-shrink-0 flex items-center justify-end pr-1 bg-sidebar border-b border-border"
      >
        <WindowControls />
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  )
}
