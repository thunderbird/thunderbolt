/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { isFramelessControlsPlatform } from '@/lib/platform'
import { Maximize2, Minus, X } from 'lucide-react'

/**
 * Custom min/maximize/close controls for the frameless Windows and Linux apps,
 * where the native title bar is hidden. Rendered once at the app root as a fixed
 * cluster pinned to the window's top-right corner — the platform-native spot for
 * caption buttons — so it stays present on every screen (including the
 * pre-database loading/auth/error screens that have no app header), mirroring
 * how macOS keeps its OS traffic lights top-left.
 *
 * It's a thin overlay, not a layout-consuming strip, so it never shifts the
 * `h-svh` content height (a full-width top strip is what previously broke chat
 * scrolling). Surfaces whose own controls reach the top-right corner (e.g. the
 * content-view panel header) reserve `--window-controls-width` of right padding
 * so they don't slide under this cluster.
 *
 * Renders `null` on macOS, mobile, and non-Tauri (web) surfaces.
 *
 * Close mirrors the tray-driven hide-instead-of-quit behavior in `tray.tsx` —
 * `close()` triggers the tray's `onCloseRequested` handler, which hides the
 * window rather than quitting.
 */
export const WindowControls = () => {
  const { t } = useLingui()
  if (!isFramelessControlsPlatform()) {
    return null
  }

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().minimize()
  }

  const handleMaximize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  }

  return (
    <div
      data-tauri-drag-region="false"
      className="fixed right-0 top-0 z-50 flex h-[var(--touch-height-xl)] w-[var(--window-controls-width)] items-stretch"
      aria-label={t`Window controls`}
    >
      <button
        type="button"
        onClick={handleMinimize}
        aria-label={t`Minimize`}
        className="flex flex-1 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={handleMaximize}
        aria-label={t`Maximize`}
        className="flex flex-1 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
      >
        <Maximize2 className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        aria-label={t`Close`}
        className="flex flex-1 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-white cursor-pointer"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
