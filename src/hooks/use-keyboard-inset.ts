import { useEffect } from 'react'

/**
 * React hook that keeps `#root` pinned to the visual viewport on mobile.
 *
 * Sets two CSS custom properties on `<html>`:
 * - `--vv-top`:    the visual-viewport's scroll offset (px). On iOS, when the
 *                  keyboard opens the browser scrolls the layout viewport --
 *                  `position: fixed` elements drift off-screen. Applying this
 *                  value to `top` compensates for that scroll.
 * - `--vv-height`: the visual-viewport's height (px). This shrinks when the
 *                  keyboard is visible, so it naturally subtracts the keyboard.
 *
 * Relies on the Visual Viewport API (all major mobile browsers). Falls back to
 * a no-op on engines that don't expose `window.visualViewport`.
 */
export const useKeyboardInset = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      const el = document.documentElement.style
      el.setProperty('--vv-top', `${vv.offsetTop}px`)
      el.setProperty('--vv-height', `${vv.height}px`)
      // --kb is still used by position:fixed dialogs (e.g. onboarding) that
      // sit outside #root's flow and need to know the keyboard height directly.
      el.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
    }

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
