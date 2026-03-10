import { useEffect } from 'react'

/**
 * Keeps CSS custom properties in sync with the visual viewport so `#root`
 * can stay pinned above the software keyboard on mobile.
 *
 * Sets on `<html>`:
 * - `--vv-height`: visual viewport height (px)
 * - `--kb`:        keyboard inset height (px)
 *
 * Prevents iOS Safari's native viewport scroll (which pushes the header
 * offscreen) by locking `window.scrollTo(0, 0)` on every animation frame
 * while the viewport is changing.
 */
export const useKeyboardInset = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let rafId = 0
    let prevHeight = vv.height
    let stableFrames = 0

    const apply = () => {
      // Prevent iOS Safari from scrolling the layout viewport
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0)
      }

      const el = document.documentElement.style
      el.setProperty('--vv-height', `${vv.height}px`)
      el.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
    }

    const poll = () => {
      apply()

      const heightChanged = vv.height !== prevHeight
      prevHeight = vv.height

      if (heightChanged) {
        stableFrames = 0
      } else {
        stableFrames++
      }

      if (stableFrames < 20) {
        rafId = requestAnimationFrame(poll)
      } else {
        rafId = 0
      }
    }

    const startPolling = () => {
      stableFrames = 0
      if (!rafId) {
        rafId = requestAnimationFrame(poll)
      }
    }

    apply()

    document.addEventListener('focusin', startPolling)
    document.addEventListener('focusout', startPolling)
    vv.addEventListener('resize', startPolling)
    vv.addEventListener('scroll', startPolling)

    return () => {
      document.removeEventListener('focusin', startPolling)
      document.removeEventListener('focusout', startPolling)
      vv.removeEventListener('resize', startPolling)
      vv.removeEventListener('scroll', startPolling)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])
}
