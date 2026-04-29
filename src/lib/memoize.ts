/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const memoizeFuncCache = Symbol.for('memoize.func_cache')
const memoizeKeyCache = Symbol.for('memoize.string_cache')

/**
 * Clears all memoized values from the global cache
 * This is primarily useful for testing to prevent pollution between tests
 */
export const clearMemoizeCache = () => {
  const keyCache: Record<string, unknown> | undefined = (globalThis as any)[memoizeKeyCache]
  if (keyCache) {
    Object.keys(keyCache).forEach((key) => delete keyCache[key])
  }
  // Note: WeakMap cache cannot be cleared, but that's okay since it's keyed by function reference
}

/**
 * Generic memoization helper that caches the function result in `globalThis`.
 * Designed to work with both synchronous and asynchronous (Promise-returning)
 * functions.  The first invocation stores the result under a unique cache key
 * and subsequent calls simply return the cached value.
 *
 * The cached value lives for the lifetime of the process or, in the browser,
 * the page.  This is ideal for expensive operations that only need to run
 * once per session, such as querying Tauri capabilities.
 *
 * Example
 * ```ts
 * const getConfig = memoize(() => fetch('/config.json').then(r => r.json()))
 * // first call performs the fetch
 * const cfg = await getConfig()
 * // later calls reuse the resolved Promise
 * ```
 */
export const memoize = <Fn extends (...args: any[]) => any>(fn: Fn, key?: string): Fn => {
  // 1. Default: cache per **function reference** (WeakMap)
  // 2. Optional: cache per explicit **string key** when callers need to share a value

  const funcCache: WeakMap<Function, unknown> =
    (globalThis as any)[memoizeFuncCache] ?? ((globalThis as any)[memoizeFuncCache] = new WeakMap())
  const keyCache: Record<string, unknown> =
    (globalThis as any)[memoizeKeyCache] ?? ((globalThis as any)[memoizeKeyCache] = {})

  return ((...args: any[]) => {
    if (key) {
      if (key in keyCache) {
        return keyCache[key] as ReturnType<Fn>
      }
      const result = fn(...args)
      keyCache[key] = result
      return result
    }

    if (funcCache.has(fn)) {
      return funcCache.get(fn) as ReturnType<Fn>
    }
    const result = fn(...args)
    funcCache.set(fn, result)
    return result
  }) as Fn
}
