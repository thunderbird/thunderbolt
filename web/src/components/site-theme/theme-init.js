/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Inlined in the head on every themed page, before any content paints.
;(() => {
  const allowOverride = document.currentScript.dataset.themeControls === 'true'
  const storageKey = 'starlight-theme'
  const root = document.documentElement
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const listeners = new Set()

  /** Production follows the OS; development can restore a preview preference. */
  const readPreference = () => {
    if (!allowOverride) return 'auto'
    try {
      const saved = localStorage.getItem(storageKey)
      return saved === 'light' || saved === 'dark' ? saved : 'auto'
    } catch {
      // Storage can be blocked in embedded or privacy-restricted preview browsers.
      return 'auto'
    }
  }

  let preference = readPreference()

  /** Publish one resolved palette to CSS and every mounted theme control. */
  const apply = () => {
    const resolved = preference === 'auto' ? (system.matches ? 'dark' : 'light') : preference
    root.dataset.themePreference = preference
    if (root.dataset.theme !== resolved) root.dataset.theme = resolved
    listeners.forEach((listener) => listener())
  }

  window.thunderboltTheme = {
    getPreference: () => preference,
    getResolvedTheme: () => root.dataset.theme,
    setPreference: (next) => {
      if (!allowOverride) return
      preference = next
      apply()
      try {
        localStorage.setItem(storageKey, next === 'auto' ? '' : next)
      } catch {
        // The preview still works in this tab when the preference cannot be persisted.
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  system.addEventListener('change', () => {
    if (preference === 'auto') apply()
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return
    preference = readPreference()
    apply()
  })
  apply()
})()
