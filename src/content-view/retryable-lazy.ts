/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

// A stylesheet still loading has no rules yet, just like one that failed, and replacing it would strand whoever waits
// on its load, such as Vite's preload for another viewer. So only links that fired error are fetched again. An
// element's error event does not bubble, but it passes the document in the capture phase. The side panel imports this
// module statically, so the listener is in place before any viewer's stylesheet is added.
const failedLinks = new WeakSet<HTMLLinkElement>()
document.addEventListener(
  'error',
  ({ target }) => {
    if (target instanceof HTMLLinkElement) {
      failedLinks.add(target)
    }
  },
  true,
)

// A second call waits on a copy still loading, because a replaced copy never fires load or error, and the first call
// would wait forever. Keyed by the copy, so one that leaves the page is never matched.
const reloading = new WeakMap<Node, Promise<void>>()

/**
 * Swaps each stylesheet that failed to load for a fresh copy, which fetches it again. Vite's preload helper never adds
 * a chunk's stylesheet twice, and does not wait for it again, so without this a chunk that loads on a retry would
 * render without its CSS. Resolves when every copy has loaded, or right away when none failed. Rejects if a copy fails
 * again; that copy is swapped on the next call.
 */
export const reloadFailedStylesheets = () => {
  const failed = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(
    (link) => reloading.has(link) || failedLinks.has(link),
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
 * `load` takes the module from a loader made with `importWhenReachable`, so the import starts only once the app's
 * server answers. The chunk must also be listed in `importsWithoutPreload` in scripts/webkit-compat.ts, so that no
 * preload of its scripts can fail on its own. Returns a getter. Call it during render to get the current component.
 */
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
