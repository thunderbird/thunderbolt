/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { startTransition, useCallback, useState } from 'react'

/** Load visible previews after the modal's entrance, keeping iframe work out of its animation. */
export const useProjectArtifactPreviewState = () => {
  const [ready, setReady] = useState(false)
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return
    }
    let active = true
    const reveal = async () => {
      const animations = element.closest('[role="dialog"]')?.getAnimations() ?? []
      // Canceled animations (including reduced-motion changes) must also release previews.
      await Promise.allSettled(animations.map((animation) => animation.finished))
      if (active) {
        startTransition(() => setReady(true))
      }
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          return
        }
        observer.disconnect()
        void reveal()
      },
      { root: element.closest('[data-slot="artifact-grid-scroll"]') },
    )
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [])
  return { ref, ready }
}
