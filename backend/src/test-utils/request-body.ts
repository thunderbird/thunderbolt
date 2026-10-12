/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A request body that delivers `firstChunk` on its first pull and errors on the next, as a connection reset
 * partway through an upload does. `state.pulls` lets a test confirm the failure came after a chunk was read.
 */
export const createMidReadFailingBody = (firstChunk: string, error = new Error('connection reset')) => {
  const state = { pulls: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      state.pulls += 1
      if (state.pulls === 1) {
        controller.enqueue(new TextEncoder().encode(firstChunk))
        return
      }
      controller.error(error)
    },
  })
  return { body, error, state }
}
