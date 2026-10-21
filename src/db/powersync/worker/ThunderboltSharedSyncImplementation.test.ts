/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { SqliteBucketStorage } from '@powersync/shared-internals'
import { ThunderboltSharedSyncImplementation } from './ThunderboltSharedSyncImplementation'

/** Exposes the protected hook and the params it reads, without a connected client. */
class Probe extends ThunderboltSharedSyncImplementation {
  streamingImplementation() {
    this.syncParams = { streamOptions: { identifier: 'test' } } as typeof this.syncParams
    return this.generateStreamingImplementation()
  }
}

/** The constructor holds a Web Lock for the worker's lifetime; the test runtime has no `navigator.locks`. */
const withNavigatorLocks = <T>(run: () => T): T => {
  Object.defineProperty(navigator, 'locks', { value: { request: () => new Promise(() => {}) }, configurable: true })
  try {
    return run()
  } finally {
    delete (navigator as { locks?: unknown }).locks
  }
}

describe('ThunderboltSharedSyncImplementation', () => {
  it('wraps control() on the bucket storage the sync stream reads', () => {
    const { adapter } = withNavigatorLocks(() => new Probe().streamingImplementation().webOptions)

    expect(adapter).toBeInstanceOf(SqliteBucketStorage)
    expect(adapter.control).not.toBe(SqliteBucketStorage.prototype.control)
  })
})
