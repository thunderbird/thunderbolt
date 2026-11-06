/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Test-only exclusive Web Locks manager; callbacks hold named locks until settlement. */
export const createTestLockManager = () => {
  const queues = new Map<string, Promise<void>>()
  return {
    request: <Result>(name: string, callback: (lock: Lock) => Promise<Result>): Promise<Result> => {
      const previous = queues.get(name) ?? Promise.resolve()
      const pending = previous.then(() => callback({ name, mode: 'exclusive' }))
      const tail = pending.then(
        () => {},
        () => {},
      )
      queues.set(name, tail)
      void tail.then(() => {
        if (queues.get(name) === tail) {
          queues.delete(name)
        }
      })
      return pending
    },
  }
}
