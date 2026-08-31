/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Request correlation for embedded surfaces.
 *
 * Mini Apps and artifacts ask their frames questions over completely different
 * envelopes — one is JSON-RPC pinned to an origin, the other is a nonce-stamped
 * message to an opaque frame — but the awkward part in the middle is identical:
 * mint an id, hold the resolver, always settle, never settle twice, and let
 * everything go on teardown.
 *
 * That middle is what lives here. Envelope and trust check stay with each
 * surface, because those genuinely differ and pretending otherwise is how a
 * shared module turns into a pile of conditionals.
 *
 * **Every request settles.** An unanswered one resolves `null` after its
 * timeout rather than hanging. Callers on both surfaces are blocking either a
 * UI affordance or a model turn, and a guest that stops replying is a case to
 * assume rather than hope against — a page can throw before it registers a
 * handler, and model-written HTML frequently does.
 */

export type PendingRequests = {
  /**
   * Mint an id, send with it, and wait.
   *
   * `send` receives the id rather than the envelope being built here: the two
   * surfaces disagree about what an envelope even looks like.
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

export const createPendingRequests = (): PendingRequests => {
  const waiting = new Map<number, (result: unknown) => void>()
  let nextId = 1

  const settle = (id: number, result: unknown): boolean => {
    const resolve = waiting.get(id)
    if (!resolve) {
      return false
    }
    // Deleted before resolving, so a resolver that synchronously issues another
    // request can't observe its own entry still in the map.
    waiting.delete(id)
    resolve(result)
    return true
  }

  return {
    issue: (send, timeoutMs) =>
      new Promise((resolve) => {
        const id = nextId++
        const timer = setTimeout(() => settle(id, null), timeoutMs)
        waiting.set(id, (result) => {
          clearTimeout(timer)
          resolve(result)
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
