import type { BucketStorageAdapter } from '@powersync/common'
import { PowerSyncDatabase } from '@powersync/web'
import type { WebPowerSyncDatabaseOptions } from '@powersync/web'
import { TransformableBucketStorage } from './TransformableBucketStorage'
import type { DataTransformMiddleware } from './TransformableBucketStorage'

export type ThunderboltPowerSyncOptions = WebPowerSyncDatabaseOptions & {
  transformers?: DataTransformMiddleware[]
}

/**
 * PowerSync database with optional data transformation middleware.
 *
 * Extends PowerSyncDatabase to use TransformableBucketStorage instead of SqliteBucketStorage,
 * enabling middleware to transform sync data before it is written to the local database.
 */
export class ThunderboltPowerSyncDatabase extends PowerSyncDatabase {
  constructor(options: ThunderboltPowerSyncOptions) {
    super(options)
  }

  /**
   * Override: Returns TransformableBucketStorage instead of SqliteBucketStorage.
   *
   * Why: PowerSyncDatabase creates a plain SqliteBucketStorage by default. We need our
   * TransformableBucketStorage so we can intercept control() and run middleware.
   *
   * What it does: Creates TransformableBucketStorage, registers any transformers from
   * options.transformers, and returns it. The adapter is used for all sync operations.
   */
  protected generateBucketStorageAdapter(): BucketStorageAdapter {
    const storage = new TransformableBucketStorage(this.database)
    const transformers = (this.options as ThunderboltPowerSyncOptions).transformers ?? []
    for (const t of transformers) {
      storage.addTransformer(t)
    }
    return storage
  }
}
