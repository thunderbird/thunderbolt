import { useLayoutEffect } from 'react'

/**
 * Detects mobile WebKit (iOS Safari and iOS Chrome/Firefox which all use WebKit).
 * We check for a small viewport (mobile) + WebKit UA signature + no Chrome/Firefox
 * desktop signatures that also include "Safari" in the UA string.
 */
const isMobileWebKit = (): boolean => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const ua = navigator.userAgent
  const isMobileViewport = window.innerWidth <= 768
  const isWebKit = /AppleWebKit/.test(ua) && /Mobile/.test(ua)
  return isMobileViewport && isWebKit
}

/**
 * Keeps `#root` pinned to the visual viewport on iOS Safari when the virtual
 * keyboard opens.
 *
 * iOS Safari scrolls the layout viewport instead of resizing it when the
 * keyboard appears. Fixed-position elements follow the layout viewport and
 * scroll off screen. This hook compensates by directly setting `#root`'s
 * `top` and `height` to match the visual viewport.
 *
 * To prevent the flash caused by Safari's native scroll-to-focused-input
 * behavior, we override `HTMLElement.prototype.focus` to always use
 * `preventScroll: true` (technique from Adobe React Spectrum).
 *
 * Uses `useLayoutEffect` for synchronous-before-paint updates and rAF
 * polling to track the keyboard animation.
 *
 * Guarded to only run on mobile WebKit — desktop browsers and non-WebKit
 * mobile browsers are unaffected.
 */
export const useKeyboardInset = (): void => {
  useLayoutEffect(() => {
    if (!isMobileWebKit()) return

    const vv = window.visualViewport
    if (!vv) return

    const root = document.getElementById('root')
    if (!root) return

    // Add class so CSS can scope fixed-positioning styles
    root.classList.add('keyboard-inset-active')

    // Override focus to prevent Safari's native scroll-to-input behavior.
    // This is the key to eliminating the flash — without it, Safari scrolls
    // the layout viewport before our JS can compensate.
    const originalFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (opts) {
      originalFocus.call(this, { ...opts, preventScroll: true })
    }

    let rafId = 0
    let prevHeight = vv.height
    let prevOffsetTop = vv.offsetTop
    let stableFrames = 0

    const apply = () => {
      root.style.top = `${vv.offsetTop}px`
      root.style.height = `${vv.height}px`

      // Set --kb on documentElement so portaled components (e.g. onboarding
      // dialog) that live outside #root can still react to keyboard height.
      const kbHeight = window.innerHeight - vv.height
      document.documentElement.style.setProperty('--kb', `${kbHeight}px`)

      // Force layout viewport back to origin
      window.scrollTo(0, 0)
    }

    const poll = () => {
      apply()

      const changed = vv.height !== prevHeight || vv.offsetTop !== prevOffsetTop
      prevHeight = vv.height
      prevOffsetTop = vv.offsetTop

      stableFrames = changed ? 0 : stableFrames + 1

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

    // Initial apply
    apply()

    document.addEventListener('focusin', startPolling)
    document.addEventListener('focusout', startPolling)
    vv.addEventListener('resize', startPolling)
    vv.addEventListener('scroll', startPolling)

    return () => {
      HTMLElement.prototype.focus = originalFocus
      root.classList.remove('keyboard-inset-active')
      document.removeEventListener('focusin', startPolling)
      document.removeEventListener('focusout', startPolling)
      vv.removeEventListener('resize', startPolling)
      vv.removeEventListener('scroll', startPolling)
      if (rafId) {
        cancelAnimationFrame(rafId)
      }
      root.style.top = ''
      root.style.height = ''
      document.documentElement.style.removeProperty('--kb')
    }
  }, [])
}
