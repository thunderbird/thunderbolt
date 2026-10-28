/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SharedWorkerConnectionRequest } from 'powersync-web-internal/worker/SharedWorkerConnectionRequest.js'
import { WorkerClient } from 'powersync-web-internal/worker/sync/WorkerClient.js'
import { ThunderboltSharedSyncImplementation } from './ThunderboltSharedSyncImplementation'

const sharedSyncImplementation = new ThunderboltSharedSyncImplementation()

/**
 * Mirrors the sync half of PowerSync's bundled worker: each client sends an inner port tagged
 * with the service it wants. Only the sync client connects here — the database runs in
 * PowerSync's own worker.
 */
// `self` in a SharedWorker context is SharedWorkerGlobalScope — not typed in DOM lib.
;(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (outerEvent: MessageEvent) => {
  outerEvent.ports[0].onmessage = ({ data: { service, port } }: MessageEvent<SharedWorkerConnectionRequest>) => {
    if (service !== 'sync') {
      throw new Error(`[ThunderboltSharedSyncImplementation] unsupported worker service: ${service}`)
    }
    new WorkerClient(sharedSyncImplementation, port)
  }
}
