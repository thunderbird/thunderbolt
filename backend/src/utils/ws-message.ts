/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const maxJsonDepth = 128
// Match Bun's default WebSocket frame limit for established connections.
const maxJsonBytes = 16 * 1024 * 1024

/** Yield JSON children lazily, so a wide container cannot fill a traversal stack. */
const jsonChildren = function* (value: object): Generator<unknown> {
  if (Array.isArray(value)) {
    yield* value
    return
  }
  for (const key in value) {
    yield key
    yield (value as Record<string, unknown>)[key]
  }
}

/**
 * Bound Elysia-parsed JSON before stringify. Byte accounting is a lower bound
 * (escaping and separators can add bytes); keep the exact serialized queue check.
 * Native binary frames do not contain a JSON tree and keep their existing handling.
 */
export const isBoundedWsJson = (message: unknown, byteBudget = maxJsonBytes): boolean => {
  if (Buffer.isBuffer(message)) {
    return message.byteLength <= byteBudget
  }
  if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
    return true
  }
  const iterators: Iterator<unknown>[] = [[message].values()]
  let remaining = byteBudget
  while (iterators.length > 0) {
    const next = iterators[iterators.length - 1].next()
    if (next.done) {
      iterators.pop()
      continue
    }
    const value = next.value
    if (value !== null && typeof value === 'object') {
      if (iterators.length > maxJsonDepth) {
        return false
      }
      remaining -= 2
      iterators.push(jsonChildren(value))
    } else {
      remaining -= typeof value === 'string' ? Buffer.byteLength(value, 'utf-8') + 2 : 1
    }
    if (remaining < 0) {
      return false
    }
  }
  return true
}
