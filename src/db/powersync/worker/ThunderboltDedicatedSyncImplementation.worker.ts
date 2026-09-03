/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBaseLogger } from '@powersync/common'
import { WorkerClient } from 'powersync-web-internal/worker/sync/WorkerClient.js'
import { ThunderboltSharedSyncImplementation } from './ThunderboltSharedSyncImplementation'

/**
 * Dedicated-Worker host for the sync stream on iOS/Safari (safari-tauri config).
 * Runs ThunderboltSharedSyncImplementation off the UI thread. A dedicated Worker has a
 * single client, so `self` is the one Comlink endpoint — no `onconnect`/multi-port handling.
 */
const logger = createBaseLogger()
logger.useDefaults()

const syncImplementation = new ThunderboltSharedSyncImplementation()

// `self` in a dedicated worker is DedicatedWorkerGlobalScope — a valid Comlink endpoint.
new WorkerClient(syncImplementation, self as unknown as MessagePort)
