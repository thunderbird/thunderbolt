/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const heldKeyStoreLock = Symbol('held-key-store-lock')
export type KeyStoreLock = typeof heldKeyStoreLock
const keyStoreLockName = 'thunderbolt-account-key-store'

/** All tabs sharing the key database must support the same exclusive writer lock. */
export const supportsKeyStoreLock = (): boolean => typeof navigator.locks?.request === 'function'

/** Hold the origin-wide key-store lock until the operation and every durable write finish. */
export const withKeyStoreLock = <Result>(operation: (lock: KeyStoreLock) => Promise<Result>): Promise<Result> =>
  navigator.locks.request(keyStoreLockName, () => operation(heldKeyStoreLock))
