/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Correlate iframe replies with requests and release unanswered requests on timeout or teardown. */

export type PendingRequests = {
  /**
   * Mint an id, send with it, and wait.
   *
   * `send` receives the id rather than the envelope being built here: callers attach their own nonce and method envelope.
   */
  issue: (send: (id: number) => void, timeoutMs: number) => Promise<unknown>
  /** Deliver a reply. Returns false when no request was waiting for that id. */
  settle: (id: number, result: unknown) => boolean
  /**
   * Resolve everything outstanding with `null`.
   *
   * For teardown: a caller awaiting an answer when the frame goes away should
   * get an empty one, not a promise that never settles.
   */
  abortAll: () => void
}

/**
 * Resolvers are held in a record rather than as bare functions so the call below
 * is a statically named member access.
 *
 * Calling the value straight out of the map trips CodeQL's
 * unvalidated-dynamic-method-call rule: `id` arrives on an untrusted
 * `postMessage`, and the query cannot tell a `Map` lookup from an object index.
 * It is a false positive — a `Map` returns only what was `set` on it, so unlike
 * `waiting[id]()` there is no prototype for a crafted id to reach — but a
 * permanently red scanner is how real findings get ignored. Keep the field.
 */
type PendingEntry = { resolve: (result: unknown) => void }

/** Create document-scoped request IDs and settle each reply at most once. */
export const createPendingRequests = (): PendingRequests => {
  const waiting = new Map<number, PendingEntry>()
  let nextId = 1

  const settle = (id: number, result: unknown): boolean => {
    const entry = waiting.get(id)
    if (!entry) {
      return false
    }
    // Deleted before resolving, so a resolver that synchronously issues another
    // request can't observe its own entry still in the map.
    waiting.delete(id)
    entry.resolve(result)
    return true
  }

  return {
    issue: (send, timeoutMs) =>
      new Promise((resolve) => {
        const id = nextId++
        const timer = setTimeout(() => settle(id, null), timeoutMs)
        waiting.set(id, {
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
        })
        send(id)
      }),
    settle,
    abortAll: () => {
      for (const id of [...waiting.keys()]) {
        settle(id, null)
      }
    },
  }
}
