/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

/**
 * Swaps each stylesheet that did not load for a fresh copy, which fetches it again. Vite's preload helper never adds a
 * chunk's stylesheet twice, so without this a chunk that loads on a retry would render without its CSS.
 */
export const reloadFailedStylesheets = () => {
  // A stylesheet that failed has no rules, and Chromium refuses to read them. The app's stylesheets are all its own,
  // so one that is unreadable for another reason is only fetched again.
  const hasRules = (link: HTMLLinkElement) => {
    try {
      return Boolean(link.sheet?.cssRules.length)
    } catch {
      return false
    }
  }
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (!hasRules(link)) {
      link.replaceWith(link.cloneNode())
    }
  }
}

/**
 * `lazy()` that can retry a failed import. `lazy()` keeps a rejected import, so a viewer whose chunk did not load on a
 * broken network would fail on every later render until the app reloads. After a failure this swaps in a new `lazy()`,
 * so the next render imports again, stylesheets included: Try again, or opening the file again.
 * Returns a getter. Call it during render to get the current component.
 */
// shortcut: WebKit remembers a `<link rel="modulepreload">` that failed, so in Safari the retry fails until a new tab
// opens; dropping script modulepreload for lazy chunks in vite.config.ts fixes it, at one more round trip per chunk.
export const retryableLazy = <P extends object>(load: () => Promise<{ default: ComponentType<P> }>) => {
  const create = (isRetry: boolean): LazyExoticComponent<ComponentType<P>> =>
    lazy(async () => {
      if (isRetry) {
        reloadFailedStylesheets()
      }
      try {
        return await load()
      } catch (error) {
        current = create(true)
        throw error
      }
    })
  let current = create(false)
  return () => current
}
