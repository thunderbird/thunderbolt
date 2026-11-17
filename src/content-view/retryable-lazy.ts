/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

// A copy that is still loading has no rules yet. A second call waits on it, because a replaced copy never fires load
// or error, and the first call would wait forever. Keyed by the copy, so one that leaves the page is never matched.
const reloading = new WeakMap<Node, Promise<void>>()

/**
 * Swaps each stylesheet that did not load for a fresh copy, which fetches it again. Vite's preload helper never adds a
 * chunk's stylesheet twice, and does not wait for it again, so without this a chunk that loads on a retry would render
 * without its CSS. Resolves when every copy has loaded, or right away when none failed. Rejects if a copy fails again.
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
  const failed = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(
    (link) => !hasRules(link),
  )
  return Promise.all(
    failed.map((link) => {
      const pending = reloading.get(link)
      if (pending) {
        return pending
      }
      const copy = link.cloneNode()
      const loaded = new Promise<void>((resolve, reject) => {
        const settle = (done: () => void) => () => {
          reloading.delete(copy)
          done()
        }
        copy.addEventListener('load', settle(resolve), { once: true })
        copy.addEventListener(
          'error',
          settle(() => reject(new Error(`Stylesheet failed to load: ${link.href}`))),
          { once: true },
        )
      })
      reloading.set(copy, loaded)
      link.replaceWith(copy)
      return loaded
    }),
  )
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
      try {
        // A stylesheet that fails again fails the import, so the panel offers Try again instead of an unstyled viewer.
        const [module] = await Promise.all([load(), isRetry ? reloadFailedStylesheets() : null])
        return module
      } catch (error) {
        current = create(true)
        throw error
      }
    })
  let current = create(false)
  return () => current
}
