/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

/**
 * `lazy()` that can retry a failed import. `lazy()` keeps a rejected import, so a viewer whose chunk did not load on a
 * broken network would fail on every later render until the app reloads. After a failure this swaps in a new `lazy()`,
 * so the next render imports again: Try again, or opening the file again.
 * Returns a getter. Call it during render to get the current component.
 */
export const retryableLazy = <P extends object>(load: () => Promise<{ default: ComponentType<P> }>) => {
  const create = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(async () => {
      try {
        return await load()
      } catch (error) {
        current = create()
        throw error
      }
    })
  let current = create()
  return () => current
}
