/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'

import { isMobile as isPlatformMobile } from '@/lib/platform'

const mobileBreakpoint = 768
const mql = () => window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`)

const subscribe = (callback: () => void) => {
  const mediaQuery = mql()
  mediaQuery.addEventListener('change', callback)
  return () => mediaQuery.removeEventListener('change', callback)
}

const getSnapshot = () => mql().matches

export const useIsMobile = () => {
  const isMobile = useSyncExternalStore(subscribe, getSnapshot)
  return { isMobile }
}

/**
 * True when the viewport is mobile-sized AND the app is the native (Tauri)
 * iOS/Android build — the combination that gets native-only spacing tweaks
 * (safe areas, keyboard insets).
 */
export const useIsNativeMobile = () => {
  const { isMobile } = useIsMobile()
  return isMobile && isPlatformMobile()
}
