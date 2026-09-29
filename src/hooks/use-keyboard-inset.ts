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
 * Keyboard-driven changes are eased rather than applied in one frame: `--kb` is a
 * registered custom property, so the transition on `:root` (index.css) interpolates
 * it and every surface reading `var(--kb)` moves with the keyboard. Viewport pans
 * opt out via `data-kb-instant` — see `update` below.
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
     *
     * `animate` decides whether this particular update eases (see the
     * `--kb` transition in index.css). The attribute is written before the
     * value so both land in the same style resolution — the browser then
     * resolves the new inset with the transition already on or off.
     */
    const update = (animate: boolean) => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.toggleAttribute('data-kb-instant', !animate)
      document.documentElement.style.setProperty('--kb', `${inset}px`)
    }

    // The resting inset: there is no previous value to move from, so no easing.
    update(false)

    // A keyboard opening or closing changes the visual viewport's size, which
    // is the one update worth easing — it's a single jump to the keyboard's
    // full height. `scroll` fires while the viewport pans (iOS keeps the
    // keyboard put and slides the viewport under it), and that re-reports the
    // inset continuously: easing those would trail the finger.
    const onResize = () => update(true)
    const onScroll = () => update(false)
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onScroll)

    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onScroll)
    }
  }, [])
}
