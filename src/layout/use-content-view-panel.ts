/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultOpenWidth, minimumWidthThreshold } from '@/content-view/constants'
import { animate } from 'framer-motion'
import { useLayoutEffect, useEffectEvent, useRef, type RefObject } from 'react'
import type { Layout, PanelImperativeHandle } from 'react-resizable-panels'

export const contentViewPanelId = 'content-view'

/** Restores a usable panel width when the saved value is absent or collapsed. */
export const getContentViewOpenWidth = (savedWidth: number | null): number =>
  savedWidth !== null && savedWidth >= minimumWidthThreshold ? savedWidth : defaultOpenWidth

type ContentViewPanelOptions = {
  isOpen: boolean
  enabled?: boolean
  panelRef: RefObject<Pick<PanelImperativeHandle, 'getSize' | 'resize'> | null>
  savedWidth: number | null
  saveWidth: (width: number) => Promise<void>
}

/** Animate panel visibility while persisting only settled user layout changes. */
export const useContentViewPanel = ({
  isOpen,
  panelRef,
  savedWidth,
  saveWidth,
  enabled = true,
}: ContentViewPanelOptions) => {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const previousOpen = useRef(isOpen)
  const isAnimating = useRef(false)
  const isExternallyResizing = useRef(false)
  const lastSettledWidth = useRef(savedWidth)
  const pendingWidth = useRef<{ width: number } | null>(null)

  const startTransition = useEffectEvent(() => {
    if (previousOpen.current === isOpen) {
      return
    }
    previousOpen.current = isOpen
    const panel = panelRef.current
    if (!panel || !enabled) {
      return
    }

    // A quick close/reopen can beat the settings query's refresh after a resize.
    const preferredWidth = pendingWidth.current?.width ?? savedWidth
    const openWidth = getContentViewOpenWidth(preferredWidth)
    const targetWidth = isOpen ? openWidth : 0
    isAnimating.current = true
    let active = true
    const animation = { current: null as ReturnType<typeof animate> | null }
    const current = () => active && enabledRef.current && panelRef.current === panel
    const frame = requestAnimationFrame(() => {
      if (!current()) {
        return
      }
      animation.current = animate(panel.getSize().asPercentage, targetWidth, {
        duration: 0.3,
        ease: [0.32, 0.72, 0, 1],
        onUpdate: (width) => {
          if (current()) {
            panel.resize(`${width}%`)
          }
        },
        onComplete: () => {
          if (!current()) {
            return
          }
          isAnimating.current = false
          if (targetWidth > 0) {
            lastSettledWidth.current = panel.getSize().asPercentage
          }
        },
      })
    })

    return () => {
      active = false
      cancelAnimationFrame(frame)
      animation.current?.stop()
      isAnimating.current = false
    }
  })

  // Cancel before an expanded route unregisters the panel from its group.
  useLayoutEffect(() => startTransition(), [isOpen, enabled])

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
    if (!isOpen || previousOpen.current !== isOpen || isAnimating.current || isExternallyResizing.current || !width) {
      return
    }
    if (lastSettledWidth.current === width) {
      return
    }
    lastSettledWidth.current = width
    return persistWidth(width)
  }

  const beginExternalResize = () => {
    isExternallyResizing.current = true
  }
  const endExternalResize = () => {
    isExternallyResizing.current = false
    const width = panelRef.current?.getSize().asPercentage
    return width ? handleLayoutChanged({ [contentViewPanelId]: width }) : undefined
  }

  return { handleLayoutChanged, beginExternalResize, endExternalResize }
}
