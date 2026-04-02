import type { DBAdapter, SyncDataBatch } from '@powersync/common'
import {
  PowerSyncControlCommand,
  SqliteBucketStorage,
  SyncDataBucket,
  SyncDataBatch as SyncDataBatchClass,
} from '@powersync/common'
import type { SyncDataBucketJSON } from '@powersync/common'

/**
 * A middleware that transforms sync data before it is written to the local database.
 *
 * Use for: data normalization, format conversion, decompression, decryption, etc.
 */
export type DataTransformMiddleware = {
  /** Receives a batch of sync data; returns the transformed batch. */
  transform(batch: SyncDataBatch): Promise<SyncDataBatch> | SyncDataBatch
}

/**
 * Extends SqliteBucketStorage with a transformation pipeline.
 *
 * PowerSync's Rust client bypasses saveSyncData and sends sync data directly to the WASM
 * engine via adapter.control(PROCESS_TEXT_LINE, payload). We override control() to intercept
 * sync data, run our middleware pipeline, then pass the transformed payload to the parent.
 */
export class TransformableBucketStorage extends SqliteBucketStorage {
  private transformers: DataTransformMiddleware[] = []

  constructor(db: DBAdapter) {
    super(db)
  }

  /** Registers a transformer to run on incoming sync data. Order matters: first added runs first. */
  addTransformer(transformer: DataTransformMiddleware): void {
    this.transformers.push(transformer)
  }

  /** Removes a previously added transformer. */
  removeTransformer(transformer: DataTransformMiddleware): void {
    const index = this.transformers.indexOf(transformer)
    if (index > -1) {
      this.transformers.splice(index, 1)
    }
  }

  /** Clears all transformers from the pipeline. */
  clearTransformers(): void {
    this.transformers = []
  }

  /** Runs all transformers in order. Each transformer receives the output of the previous. */
  private async runTransformers(batch: SyncDataBatch): Promise<SyncDataBatch> {
    let result = batch
    for (const transformer of this.transformers) {
      result = await transformer.transform(result)
    }
    return result
  }

  /**
   * Override: Intercepts control() for PROCESS_TEXT_LINE sync data.
   *
   * Why: The Rust client calls this when it receives sync data from the server. The default
   * implementation passes the payload straight to powersync_control (WASM). We intercept to
   * run our middleware (transformers) before the data reaches the database.
   *
   * What it does: For PROCESS_TEXT_LINE with sync data, parses the payload, runs the
   * transformer pipeline, and passes the transformed payload to the parent. All other
   * commands (STOP, START, PROCESS_BSON_LINE, etc.) pass through unchanged.
   */
  async control(op: PowerSyncControlCommand, payload: string | Uint8Array | ArrayBuffer | null): Promise<string> {
    if (
      op === PowerSyncControlCommand.PROCESS_TEXT_LINE &&
      typeof payload === 'string' &&
      this.transformers.length > 0
    ) {
      try {
        const line = JSON.parse(payload) as { data?: SyncDataBucketJSON }
        if (line?.data) {
          const bucket = SyncDataBucket.fromRow(line.data)
          const batch = new SyncDataBatchClass([bucket])
          const transformed = await this.runTransformers(batch)
          const transformedPayload = JSON.stringify({
            data: transformed.buckets[0].toJSON(true),
          })
          return super.control(op, transformedPayload)
        }
      } catch (err) {
        console.warn('[TransformableBucketStorage] Transform failed:', err)
        throw err
      }
    }
    return super.control(op, payload)
  }
}
