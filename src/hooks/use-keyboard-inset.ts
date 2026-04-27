/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'

/**
 * React hook that maintains the `--kb` CSS custom property on the root `<html>` element.
 * The property reflects the height (in pixels) of the area currently covered by the
 * software keyboard. When the keyboard is hidden, the value is `0px`.
 *
 * It relies on the Visual Viewport API, which is supported by all major mobile browsers
 * (Safari iOS, Chrome/Edge/Opera/Samsung Internet, Firefox Android) and desktop Chromium.
 *
 * The hook is safe to use on older engines that don’t expose `window.visualViewport` –
 * it simply becomes a no-op, leaving `--kb` at its initial `0px`.
 *
 * Usage:
 *   // Call it once at the top level of your app
 *   useKeyboardInset()
 */
export const useKeyboardInset = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) {
      return
    } // VisualViewport API not supported

    /**
     * Calculates and sets the CSS variable based on the difference between the
     * layout viewport (`window.innerHeight`) and the visual viewport (`vv.height`).
     * On iOS the layout viewport stays constant and the visual viewport shrinks
     * when the keyboard appears. On Android/Chromium both shrink, but the math
     * still produces a non-negative inset that matches the covered area.
     */
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--kb', `${inset}px`)
    }

    // Initial run
    update()

    // iOS fires `scroll` when the viewport pans, Android fires `resize`
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
}
