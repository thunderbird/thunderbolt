/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { getPlatform, isTauri, isWebMobilePlatform } from '@/lib/platform'

/**
 * Locks the layout viewport at scroll position 0, preventing iOS Safari from
 * scrolling fixed-position elements off-screen when the software keyboard opens.
 *
 * On iOS, `position: fixed` anchors to the layout viewport, which Safari scrolls
 * independently of the visual viewport when the keyboard appears. This causes
 * fixed headers/toolbars to jump or disappear. This hook prevents that with a
 * three-layer defense:
 *
 * 1. `position: fixed` on `<html>` — blocks most iOS viewport scrolling
 * 2. Touch interception on inputs — `focus({ preventScroll: true })` prevents
 *    iOS's automatic scroll-into-view when the keyboard opens
 * 3. rAF scroll-reset loop on focus/blur — catches programmatic focus and any
 *    residual scroll during the ~300ms keyboard animation
 *
 * Skipped on Tauri iOS where the native lockWebViewScrollPosition() (main.mm)
 * handles the WKWebView scroll lock instead — running both causes a blank gap.
 * Runs normally on Tauri Android (no native scroll lock available).
 *
 * Pair with `paddingBottom: var(--kb)` on content containers so inputs remain
 * visible above the keyboard (see `useKeyboardInset` for the `--kb` variable).
 */
export const useViewportLock = (): void => {
  useEffect(() => {
    // Tauri iOS: setting position:fixed + height:100% on <html> causes a blank
    // gap in the WKWebView. The native lockWebViewScrollPosition() (main.mm)
    // handles the scroll lock instead. We only need to scroll the focused input
    // into view after the keyboard appears and --kb reflows layout.
    // Tauri iOS/Android: the native WebView handles scroll locking
    // (iOS: lockWebViewScrollPosition in main.mm, Android: MainActivity.kt).
    // We only scroll the focused input into view after --kb reflows layout.
    if (isTauri()) {
      // On Android with adjustNothing, --kb padding already repositions the input.
      // scrollIntoView during the keyboard animation causes visible flickering.
      // Only run on iOS where the native scroll lock needs this assist.
      if (getPlatform() !== 'ios') {
        return
      }

      const vv = window.visualViewport
      if (!vv) {
        return
      }

      const isFocusable = (el: Element | null): el is HTMLElement =>
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)

      let timer: ReturnType<typeof setTimeout> | undefined
      const onResize = () => {
        clearTimeout(timer)
        const active = document.activeElement
        if (isFocusable(active)) {
          timer = setTimeout(() => {
            active.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }, 350)
        }
      }

      vv.addEventListener('resize', onResize)
      return () => {
        clearTimeout(timer)
        vv.removeEventListener('resize', onResize)
      }
    }

    // Web path: these workarounds target mobile Safari/Chrome — skip on desktop
    // browsers where they cause unexpected scrollIntoView on window resize and
    // break first-tap cursor placement on touch-screen laptops.
    if (!isWebMobilePlatform()) {
      return
    }

    const html = document.documentElement
    html.style.position = 'fixed'
    html.style.width = '100%'
    html.style.height = '100%'

    const forceScrollTop = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0)
      }
    }

    const isFocusable = (el: EventTarget | null): el is HTMLElement =>
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)

    // Intercept touch on focusable elements — prevent iOS's automatic
    // scroll-into-view by manually focusing with preventScroll.
    // Skip if the element is already focused to preserve cursor repositioning.
    // Skip native picker inputs (date, time, file, etc.) — preventDefault suppresses
    // the synthetic click that iOS uses to open the picker UI.
    const pickerTypes = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'file', 'color'])
    const onTouchEnd = (e: TouchEvent) => {
      const target = e.target
      if (isFocusable(target) && target !== document.activeElement) {
        if (target instanceof HTMLInputElement && pickerTypes.has(target.type)) {
          return
        }
        e.preventDefault()
        target.focus({ preventScroll: true })
      }
    }

    // Since preventScroll suppresses all scrolling (including inner scroll
    // containers), we manually scroll the focused element into view once the
    // keyboard has appeared and the layout has reflowed via --kb.
    let scrollIntoViewTimer: ReturnType<typeof setTimeout> | undefined
    const scrollFocusedElementIntoView = () => {
      clearTimeout(scrollIntoViewTimer)
      const active = document.activeElement
      if (isFocusable(active)) {
        scrollIntoViewTimer = setTimeout(() => {
          active.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 350) // Wait for keyboard animation + --kb layout reflow
      }
    }

    // During keyboard open/close (~300ms), run scrollTo(0,0) every frame
    // to fight any residual iOS viewport scrolling.
    let rafId: number | undefined
    let rafTimeout: ReturnType<typeof setTimeout> | undefined

    const startScrollResetLoop = () => {
      cancelAnimationFrame(rafId!)
      clearTimeout(rafTimeout)
      const loop = () => {
        forceScrollTop()
        rafId = requestAnimationFrame(loop)
      }
      rafId = requestAnimationFrame(loop)
      rafTimeout = setTimeout(() => cancelAnimationFrame(rafId!), 500)
    }

    document.addEventListener('touchend', onTouchEnd, { passive: false })
    document.addEventListener('focusin', startScrollResetLoop)
    document.addEventListener('focusout', startScrollResetLoop)
    window.addEventListener('scroll', forceScrollTop, { passive: false })

    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener('scroll', forceScrollTop)
      vv.addEventListener('resize', forceScrollTop)
      vv.addEventListener('resize', scrollFocusedElementIntoView)
    }

    return () => {
      html.style.position = ''
      html.style.width = ''
      html.style.height = ''
      cancelAnimationFrame(rafId!)
      clearTimeout(rafTimeout)
      clearTimeout(scrollIntoViewTimer)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('focusin', startScrollResetLoop)
      document.removeEventListener('focusout', startScrollResetLoop)
      window.removeEventListener('scroll', forceScrollTop)
      if (vv) {
        vv.removeEventListener('scroll', forceScrollTop)
        vv.removeEventListener('resize', forceScrollTop)
        vv.removeEventListener('resize', scrollFocusedElementIntoView)
      }
    }
  }, [])
}
