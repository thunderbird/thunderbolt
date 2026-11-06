/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'auto' | 'dark'
export type ResolvedTheme = Exclude<ThemePreference, 'auto'>

declare global {
  interface Window {
    thunderboltTheme: {
      getPreference: () => ThemePreference
      getResolvedTheme: () => ResolvedTheme
      setPreference: (theme: ThemePreference) => void
      subscribe: (listener: () => void) => () => void
    }
  }
}

const subscribe = (listener: () => void) => window.thunderboltTheme.subscribe(listener)
const getResolvedTheme = () => window.thunderboltTheme.getResolvedTheme()
const getServerTheme = (): ResolvedTheme => 'light'

/** Subscribe to the same pre-paint theme store on marketing, blog, and docs pages. */
export const useSiteTheme = () => ({
  resolvedTheme: useSyncExternalStore(subscribe, getResolvedTheme, getServerTheme),
  setPreference: (theme: ThemePreference) => window.thunderboltTheme.setPreference(theme),
})
