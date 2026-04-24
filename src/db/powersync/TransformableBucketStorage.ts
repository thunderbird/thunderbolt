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
 * PowerSync's Rust client sends sync data to the WASM engine via
 * adapter.control(PROCESS_TEXT_LINE | PROCESS_BSON_LINE, payload).
 * We override control() to intercept both text (JSON) and binary (BSON) sync data,
 * run our middleware pipeline, then pass the transformed payload to the parent.
 */
export class TransformableBucketStorage extends SqliteBucketStorage {
  private transformers: DataTransformMiddleware[] = []
  private bsonModule: typeof import('bson').BSON | null = null

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

  /** Lazy-loads the BSON module for deserializing/serializing binary sync payloads. */
  private async getBSON() {
    if (!this.bsonModule) {
      const { BSON } = await import('bson')
      this.bsonModule = BSON
    }
    return this.bsonModule
  }

  /**
   * Override: Intercepts control() for both PROCESS_TEXT_LINE and PROCESS_BSON_LINE sync data.
   *
   * PowerSync >= 1.37 prefers BSON over NDJSON for HTTP sync streams (via Accept header).
   * We must handle both formats to ensure middleware runs regardless of server response type.
   *
   * For sync data lines, parses the payload (JSON or BSON), runs the transformer pipeline,
   * re-encodes in the original format, and passes to the parent. Non-sync commands
   * (STOP, START, etc.) pass through unchanged.
   */
  async control(op: PowerSyncControlCommand, payload: string | Uint8Array | ArrayBuffer | null): Promise<string> {
    if (this.transformers.length === 0) {
      return super.control(op, payload)
    }

    if (op === PowerSyncControlCommand.PROCESS_TEXT_LINE && typeof payload === 'string') {
      try {
        const line = JSON.parse(payload) as { data?: SyncDataBucketJSON }
        if (line?.data) {
          const transformed = await this.transformBucket(line.data)
          return super.control(op, JSON.stringify({ data: transformed }))
        }
      } catch (err) {
        console.warn('[TransformableBucketStorage] Text transform failed:', err)
        throw err
      }
    }

    if (op === PowerSyncControlCommand.PROCESS_BSON_LINE && payload != null && typeof payload !== 'string') {
      try {
        const bson = await this.getBSON()
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
        const line = bson.deserialize(bytes) as { data?: SyncDataBucketJSON }
        if (line?.data) {
          const transformed = await this.transformBucket(line.data)
          return super.control(op, bson.serialize({ data: transformed }))
        }
      } catch (err) {
        console.warn('[TransformableBucketStorage] BSON transform failed:', err)
        throw err
      }
    }

    return super.control(op, payload)
  }

  /** Transforms a single sync data bucket through the middleware pipeline. */
  private async transformBucket(syncData: SyncDataBucketJSON): Promise<SyncDataBucketJSON> {
    const bucket = SyncDataBucket.fromRow(syncData)
    const batch = new SyncDataBatchClass([bucket])
    const transformed = await this.runTransformers(batch)
    return transformed.buckets[0].toJSON(true)
  }
}
