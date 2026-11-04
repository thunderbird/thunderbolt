/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SharedSyncImplementation } from 'powersync-web-internal/worker/sync/SharedSyncImplementation.js'
import { syncTransformers } from '../middleware'
import { installSyncTransformers } from '../sync-transform'

/**
 * SharedSyncImplementation whose sync stream runs every line through `syncTransformers`
 * before it reaches the local database.
 *
 * The worker builds its own bucket storage in `generateStreamingImplementation()`, out of reach
 * of anything configured on the main thread, so the override lets upstream build the streaming
 * implementation unchanged and only wraps `control()` on the adapter it created.
 */
export class ThunderboltSharedSyncImplementation extends SharedSyncImplementation {
  protected override generateStreamingImplementation() {
    const streamingSync = super.generateStreamingImplementation()
    installSyncTransformers(streamingSync.webOptions.adapter, syncTransformers)
    return streamingSync
  }
}
