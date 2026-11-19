/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOpenWidth, minimumWidthThreshold } from '@/content-view/constants'
import { animate } from 'framer-motion'
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'
import type { Layout, PanelImperativeHandle } from 'react-resizable-panels'

export const contentViewPanelId = 'content-view'

type ContentViewPanelOptions = {
  isOpen: boolean
  panelRef: RefObject<Pick<PanelImperativeHandle, 'getSize' | 'resize'> | null>
  savedWidth: number | null
  saveWidth: (width: number) => Promise<void>
}

/** Animate panel visibility while persisting only settled user layout changes. */
export const useContentViewPanel = ({ isOpen, panelRef, savedWidth, saveWidth }: ContentViewPanelOptions) => {
  const previousOpen = useRef(isOpen)
  const isAnimating = useRef(false)
  const lastSettledWidth = useRef(savedWidth)
  const pendingWidth = useRef<{ width: number } | null>(null)

  const startTransition = useEffectEvent(() => {
    if (previousOpen.current === isOpen) {
      return
    }
    previousOpen.current = isOpen
    const panel = panelRef.current
    if (!panel) {
      return
    }

    // A quick close/reopen can beat the settings query's refresh after a resize.
    const preferredWidth = pendingWidth.current?.width ?? savedWidth
    const openWidth =
      preferredWidth !== null && preferredWidth >= minimumWidthThreshold ? preferredWidth : defaultOpenWidth
    const targetWidth = isOpen ? openWidth : 0
    isAnimating.current = true
    const animation = { current: null as ReturnType<typeof animate> | null }
    const frame = requestAnimationFrame(() => {
      animation.current = animate(panel.getSize().asPercentage, targetWidth, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onUpdate: (width) => panel.resize(`${width}%`),
        onComplete: () => {
          isAnimating.current = false
          if (targetWidth > 0) {
            lastSettledWidth.current = panel.getSize().asPercentage
          }
        },
      })
    })

    return () => {
      cancelAnimationFrame(frame)
      animation.current?.stop()
      isAnimating.current = false
    }
  })

  useEffect(() => startTransition(), [isOpen])

  /** Release the temporary preference when a save settles, without clearing a newer resize. */
  const persistWidth = async (width: number) => {
    const pending = { width }
    pendingWidth.current = pending
    try {
      await saveWidth(width)
    } finally {
      if (pendingWidth.current === pending) {
        pendingWidth.current = null
      }
    }
  }

  // Group calls this once on pointer release and for each keyboard resize.
  // Its imperative resize callbacks also arrive here during our animation.
  const handleLayoutChanged = (layout: Layout) => {
    const width = layout[contentViewPanelId]
    if (!isOpen || previousOpen.current !== isOpen || isAnimating.current || !width) {
      return
    }
    if (lastSettledWidth.current === width) {
      return
    }
    lastSettledWidth.current = width
    return persistWidth(width)
  }

  return { handleLayoutChanged }
}
