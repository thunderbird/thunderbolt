/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PowerSyncControlCommand } from '@powersync/shared-internals'
import type { BucketStorageAdapter } from '@powersync/shared-internals'
import type { SyncDataBucketJSON } from '@powersync/shared-internals/internal/sync_protocol'

/**
 * One bucket of sync data — the unit delivered by the Rust sync client via a
 * single `control(PROCESS_TEXT_LINE | PROCESS_BSON_LINE)` call.
 *
 * Re-exported with a friendly name so middleware authors don't import from
 * PowerSync's `internal/sync_protocol` path.
 */
export type SyncDataBucket = SyncDataBucketJSON

/**
 * A middleware that transforms sync data before it is written to the local database.
 *
 * Use for: data normalization, format conversion, decompression, decryption, etc.
 */
export type DataTransformMiddleware = {
  /** Receives one bucket of sync data; returns the transformed bucket. */
  transform(bucket: SyncDataBucket): Promise<SyncDataBucket> | SyncDataBucket
}

type ControlPayload = Parameters<BucketStorageAdapter['control']>[1]

/** Runs all transformers in order. Each transformer receives the output of the previous. */
const runTransformers = async (bucket: SyncDataBucket, transformers: DataTransformMiddleware[]) => {
  let result = bucket
  for (const transformer of transformers) {
    result = await transformer.transform(result)
  }
  return result
}

const unexpectedPayloadError = (op: PowerSyncControlCommand, payload: ControlPayload) =>
  new Error(`[sync-transform] unexpected ${payload === null ? 'null' : typeof payload} payload for ${op}`)

/**
 * Transforms one sync line, re-encoded in the format it arrived in (JSON → JSON, BSON → BSON).
 *
 * PowerSync prefers BSON over NDJSON for HTTP sync streams, so both formats must be handled
 * for middleware to run regardless of the server's response type. Lines that carry no bucket
 * data (checkpoints, etc.) and every non-line command (START, STOP, …) pass through unchanged.
 * A sync line in a shape we can't parse throws rather than reaching SQLite untransformed — that
 * would persist ciphertext and skip the plaintext quarantine.
 */
const transformLine = async (
  op: PowerSyncControlCommand,
  payload: ControlPayload,
  transformers: DataTransformMiddleware[],
): Promise<ControlPayload> => {
  if (op === PowerSyncControlCommand.PROCESS_TEXT_LINE) {
    if (typeof payload !== 'string') {
      throw unexpectedPayloadError(op, payload)
    }
    const line = JSON.parse(payload) as { data?: SyncDataBucket } | null
    if (!line?.data) {
      return payload
    }
    return JSON.stringify({ data: await runTransformers(line.data, transformers) })
  }

  if (op === PowerSyncControlCommand.PROCESS_BSON_LINE) {
    if (!(payload instanceof Uint8Array)) {
      throw unexpectedPayloadError(op, payload)
    }
    // Loaded on the first binary line, not at module load: bson's Node entry can't load under
    // Bun, and every test importing the database layer would otherwise trip over it.
    const { BSON: bson } = await import('bson')
    const line = bson.deserialize(payload) as { data?: SyncDataBucket }
    if (!line.data) {
      return payload
    }
    return bson.serialize({ data: await runTransformers(line.data, transformers) })
  }

  return payload
}

/**
 * Routes every sync-data line through `transformers` before PowerSync's Rust core applies it,
 * by replacing `control()` on this adapter instance.
 *
 * PowerSync has no supported hook for this: the Rust client feeds each line to the storage
 * adapter via `control(PROCESS_TEXT_LINE | PROCESS_BSON_LINE, payload)`, so we wrap that one
 * method on the adapter PowerSync built. Wrapping (rather than replacing the adapter) keeps the
 * adapter's own listeners and lifecycle intact. A transformer error propagates, so a line is
 * never applied untransformed — PowerSync retries the stream.
 */
export const installSyncTransformers = (
  adapter: Pick<BucketStorageAdapter, 'control'>,
  transformers: DataTransformMiddleware[],
) => {
  const control = adapter.control.bind(adapter)
  adapter.control = async (op, payload) => control(op, await transformLine(op, payload, transformers))
}
