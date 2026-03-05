import { createBaseLogger } from '@powersync/common'
import { WorkerClient } from 'powersync-web-internal/worker/sync/WorkerClient.js'
import { ThunderboltSharedSyncImplementation } from './ThunderboltSharedSyncImplementation'

const logger = createBaseLogger()
logger.useDefaults()

const sharedSyncImplementation = new ThunderboltSharedSyncImplementation()

// `self` in a SharedWorker context is SharedWorkerGlobalScope — not typed in DOM lib.
;(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = async (event: MessageEvent) => {
  const port = event.ports[0]
  new WorkerClient(sharedSyncImplementation, port)
}
