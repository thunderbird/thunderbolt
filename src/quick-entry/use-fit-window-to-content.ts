/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getCurrentWindow, PhysicalPosition, PhysicalSize, type Window } from '@tauri-apps/api/window'
import { type RefObject, useEffect, useState } from 'react'

export type FittedWindow = Pick<Window, 'scaleFactor' | 'outerPosition' | 'outerSize' | 'setPosition' | 'setSize'>

/**
 * Resize the window to the height of `contentRef`, keeping its bottom edge where
 * it is.
 *
 * The panel opens just above the Dock, so a growing textarea has to push the
 * top edge up; `setSize` alone keeps the top-left corner and would grow it down
 * off the screen. A tall window with a transparent top would avoid resizing,
 * but its empty part would still swallow clicks meant for the app behind it.
 */
export const useFitWindowToContent = (contentRef: RefObject<HTMLElement | null>, fittedWindow?: FittedWindow) => {
  const [appWindow] = useState<FittedWindow>(() => fittedWindow ?? getCurrentWindow())

  useEffect(() => {
    const content = contentRef.current
    if (!content) {
      return
    }

    const fit = async (contentHeight: number) => {
      const [scale, position, size] = await Promise.all([
        appWindow.scaleFactor(),
        appWindow.outerPosition(),
        appWindow.outerSize(),
      ])
      const height = Math.ceil(contentHeight * scale)
      if (height === size.height) {
        return
      }
      await appWindow.setPosition(new PhysicalPosition(position.x, position.y + size.height - height))
      await appWindow.setSize(new PhysicalSize(size.width, height))
    }

    // One fit at a time, always to the latest height. Each fit reads the window's
    // position and size, so a fit started while another is between its
    // `setPosition` and `setSize` would read a half-applied move and drift the
    // bottom edge; one that read the size before an earlier fit landed could
    // also skip a resize it needed.
    const queue = { latestHeight: null as number | null, running: false }
    const fitLatest = async () => {
      if (queue.running) {
        return
      }
      queue.running = true
      try {
        while (queue.latestHeight !== null) {
          const contentHeight = queue.latestHeight
          queue.latestHeight = null
          await fit(contentHeight)
        }
      } finally {
        queue.running = false
      }
    }

    const observer = new ResizeObserver(([entry]) => {
      queue.latestHeight = entry.borderBoxSize[0].blockSize
      void fitLatest()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, appWindow])
}
