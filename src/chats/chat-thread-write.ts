/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const pendingWrites = new Map<string, Promise<void>>()

/** Serialize initial thread creation and project moves, including their live session updates. */
export const withChatThreadWrite = async <T>(chatThreadId: string, write: () => Promise<T>): Promise<T> => {
  const previous = pendingWrites.get(chatThreadId)
  const { promise, resolve } = Promise.withResolvers<void>()
  pendingWrites.set(chatThreadId, promise)
  try {
    await previous
    return await write()
  } finally {
    resolve()
    if (pendingWrites.get(chatThreadId) === promise) {
      pendingWrites.delete(chatThreadId)
    }
  }
}
