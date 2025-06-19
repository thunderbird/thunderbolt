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
export function memoize<Fn extends (...args: any[]) => any>(fn: Fn, key: string = fn.name || 'anon'): Fn {
  // A single cache bag shared across the whole application.
  const BAG = Symbol.for('memoize.cache')
  const cache: Record<string, unknown> = (globalThis as any)[BAG] ?? ((globalThis as any)[BAG] = {})

  return ((...args: any[]) => {
    if (key in cache) return cache[key] as ReturnType<Fn>
    const result = fn(...args)
    cache[key] = result
    return result
  }) as Fn
}
