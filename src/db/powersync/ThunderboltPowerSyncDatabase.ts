/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BucketStorageAdapter } from '@powersync/shared-internals'
import { WebPowerSyncDatabase } from '@powersync/web'
import { syncTransformers } from './middleware'
import { installSyncTransformers } from './sync-transform'

/**
 * PowerSync database whose main-thread bucket storage runs sync data through `syncTransformers`.
 *
 * Extends `WebPowerSyncDatabase` (`@internal` upstream) rather than `PowerSyncDatabase`, which
 * is only a typed constructor alias and hides the protected hook.
 *
 * This adapter is on the sync path only when sync runs in the tab (`enableMultiTabs` resolves
 * false, e.g. Android or the IndexedDB fallback); otherwise the sync worker builds its own (see
 * `ThunderboltSharedSyncImplementation`).
 */
export class ThunderboltPowerSyncDatabase extends WebPowerSyncDatabase {
  protected override generateBucketStorageAdapter(): BucketStorageAdapter {
    const adapter = super.generateBucketStorageAdapter()
    installSyncTransformers(adapter, syncTransformers)
    return adapter
  }
}
