/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { SqliteBucketStorage } from '@powersync/shared-internals'
import { ThunderboltPowerSyncDatabase } from './ThunderboltPowerSyncDatabase'

/** Exposes the protected hook without the constructor, which would open a real database. */
class Probe extends ThunderboltPowerSyncDatabase {
  bucketStorage() {
    return this.generateBucketStorageAdapter()
  }
}

describe('ThunderboltPowerSyncDatabase', () => {
  it('wraps control() on the bucket storage the in-tab sync stream reads', () => {
    const probe: Probe = Object.create(Probe.prototype, {
      database: { value: { registerListener: () => () => {} } },
    })
    const adapter = probe.bucketStorage()

    expect(adapter).toBeInstanceOf(SqliteBucketStorage)
    expect(adapter.control).not.toBe(SqliteBucketStorage.prototype.control)
  })
})
