/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { CloudDatabase } from './service'
import { createCloudAgentService } from './service'
import { readCloudSettings } from './config'
import { createArtifactService } from './artifacts'
import { createS3ArtifactObjectStore } from './artifacts/object-store'
import { managedCloudModel, createRuntimeHost } from './host'
import { openPostgresRuntimeStore } from './storage'
import { createCloudRuntime } from './runtime'
import { createCloudScheduler } from './scheduler'
import { startCloudAgentLifecycle } from './lifecycle'

/** Construct API dependencies without starting background work (also used by route tests). */
export const createCloudAgentModule = (database: CloudDatabase, settings: Settings) => {
  const cloud = readCloudSettings()
  const service = createCloudAgentService(database, cloud, managedCloudModel(settings))
  const bucket = process.env.CLOUD_ARTIFACT_BUCKET
  const artifacts =
    cloud.identity && bucket
      ? createArtifactService({
          database,
          runtimeIdentity: cloud.identity,
          maxArtifactBytes: cloud.maxArtifactBytes,
          maxStorageBytes: cloud.maxStorageBytes,
          objects: createS3ArtifactObjectStore({
            bucket,
            region: process.env.CLOUD_ARTIFACT_REGION ?? 'us-east-1',
            endpoint: process.env.CLOUD_ARTIFACT_ENDPOINT,
            forcePathStyle: process.env.CLOUD_ARTIFACT_FORCE_PATH_STYLE === 'true',
            ...(process.env.CLOUD_ARTIFACT_ACCESS_KEY_ID && process.env.CLOUD_ARTIFACT_SECRET_ACCESS_KEY
              ? {
                  credentials: {
                    accessKeyId: process.env.CLOUD_ARTIFACT_ACCESS_KEY_ID,
                    secretAccessKey: process.env.CLOUD_ARTIFACT_SECRET_ACCESS_KEY,
                  },
                }
              : {}),
          }),
        })
      : null
  return { service, artifacts }
}

export type CloudAgentModule = ReturnType<typeof createCloudAgentModule>

/** Startup happens once, in the API's own Bun process, after schema migration. */
export const startCloudAgents = async (
  module: CloudAgentModule,
  settings: Settings,
  reportError: (code: string) => void,
) => {
  if (!module.service.settings.enabled) {
    return { close: async () => {} }
  }
  if (!process.env.DATABASE_URL || process.env.DATABASE_DRIVER === 'pglite') {
    throw new Error('Cloud agents require Postgres')
  }
  if (!module.artifacts) {
    throw new Error('CLOUD_ARTIFACT_BUCKET is required for cloud agents')
  }
  const artifacts = module.artifacts
  const connectionString = process.env.DATABASE_URL
  return startCloudAgentLifecycle({
    openStore: (onFatal) => openPostgresRuntimeStore({ connectionString, onFatal }),
    createRuntime: (store) => createCloudRuntime(store, createRuntimeHost(module.service, artifacts, settings)),
    createScheduler: (runtime) => createCloudScheduler(module.service, runtime, reportError),
    collectGarbage: () => artifacts.collectGarbage(),
    onFatal: (error) => {
      module.service.settings.executionEnabled = false
      reportError(error.name)
      // Losing the owning database session invalidates every outstanding execution lease.
      process.exitCode = 1
    },
    reportError,
  })
}
