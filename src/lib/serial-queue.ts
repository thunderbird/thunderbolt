/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Admit resource operations in order; a failure is returned to its caller without poisoning cleanup. */
export const createSerialQueue = () => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation)
    tail = next.catch(() => {})
    return next
  }
}
