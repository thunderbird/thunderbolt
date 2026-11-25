/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { http } from '@/lib/http'
import { isTauri } from '@/lib/platform'

// A HEAD of a static file has no body, so even a slow mobile link answers well within this. A server that takes the
// connection and never answers then gets Try again instead of a spinner that never ends.
const reachableTimeout = 5000

/**
 * Resolves once the server that hosts the app's chunks answers, and rejects if it answers with an error or not within
 * {@link reachableTimeout}. Safari keeps every module that failed to load for as long as the page lives, the module an
 * `import()` asked for included, so an import tried while the server is down fails again on every retry. This module's
 * own URL is on that server. The desktop and mobile apps load their chunks from the device, so they never check.
 */
const chunksReachable = async () => {
  if (isTauri()) {
    return
  }
  await http.head(import.meta.url, { cache: 'no-store', timeout: reachableTimeout })
}

/**
 * Wraps a dynamic import so it starts only after the app's server answered, which costs one round trip. Once it has
 * loaded, later calls return it without checking again. After a failure, the next call checks again. Every import of
 * one module shares one loader, so once it has loaded for one caller, another gets it without the network.
 */
export const importWhenReachable = <T>(load: () => Promise<T>) => {
  let loaded: Promise<T> | null = null
  const attempt = async () => {
    try {
      await chunksReachable()
      return await load()
    } catch (error) {
      loaded = null
      throw error
    }
  }
  return (): Promise<T> => (loaded ??= attempt())
}
