/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WorkerClient } from 'powersync-web-internal/worker/sync/WorkerClient.js'
import { ThunderboltSharedSyncImplementation } from './ThunderboltSharedSyncImplementation'

/**
 * Dedicated-Worker host for the sync stream on iOS/Safari (safari-tauri config).
 * Runs ThunderboltSharedSyncImplementation off the UI thread. A dedicated Worker has a
 * single client and PowerSync uses it directly as the Comlink endpoint, so `self` is the
 * port — no `onconnect`/service handshake.
 */
const syncImplementation = new ThunderboltSharedSyncImplementation()

// `self` in a dedicated worker is DedicatedWorkerGlobalScope — a valid Comlink endpoint.
new WorkerClient(syncImplementation, self as unknown as MessagePort)
