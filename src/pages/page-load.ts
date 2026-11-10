/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type LoadState = { url: string; isLoading: boolean; error?: string | null }

/** Await an engine operation without allowing a hung bridge reply to defeat Stop or the deadline. */
const withinSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })

/** Wait for committed navigation and redirects, without depending on network-idle or long-lived page requests. */
export const waitForPageLoad = async (
  readState: () => Promise<LoadState | undefined>,
  signal?: AbortSignal,
  { timeoutMs = 30_000, quietMs = 200 } = {},
): Promise<void> => {
  const timeout = new AbortController()
  const deadline = setTimeout(
    () => timeout.abort(new Error('Page is still loading. Wait and observe it again.')),
    timeoutMs,
  )
  const pending = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let stable: { url: string; since: number } | undefined
  try {
    while (true) {
      pending.throwIfAborted()
      const state = await withinSignal(readState(), pending)
      pending.throwIfAborted()
      if (state?.error) {
        throw new Error(state.error)
      }
      if (!state || state.isLoading) {
        stable = undefined
      } else if (!stable || stable.url !== state.url) {
        stable = { url: state.url, since: Date.now() }
      } else if (Date.now() - stable.since >= quietMs) {
        return
      }
      await withinSignal(new Promise((resolve) => setTimeout(resolve, 50)), pending)
    }
  } finally {
    clearTimeout(deadline)
  }
}
