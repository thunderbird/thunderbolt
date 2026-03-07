/**
 * Races a promise against a timeout. On timeout, resolves with `undefined`
 * (does not throw) so callers' `finally` blocks still run normally.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`[withTimeout] "${label}" timed out after ${ms}ms`)
      resolve(undefined)
    }, ms)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}
