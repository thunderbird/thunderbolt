/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { PowerSyncControlCommand } from '@powersync/shared-internals'
import type { BucketStorageAdapter } from '@powersync/shared-internals'
import { installSyncTransformers } from './sync-transform'
import type { DataTransformMiddleware, SyncDataBucket } from './sync-transform'

// bson's Node entry probes `node:v8`'s isBuildingSnapshot while it loads, which Bun has not
// implemented; the browser build the app ships never does. Hide `v8` for that one load —
// the module is cached afterwards, including for sync-transform's own lazy import.
const getBuiltinModule = process.getBuiltinModule
process.getBuiltinModule = ((id: string) => (id === 'v8' ? {} : getBuiltinModule(id))) as typeof getBuiltinModule
const bson = await (async () => {
  try {
    return (await import('bson')).BSON
  } finally {
    process.getBuiltinModule = getBuiltinModule
  }
})()

type ControlCall = [PowerSyncControlCommand, string | Uint8Array | null]

const fakeAdapter = () => {
  const calls: ControlCall[] = []
  const adapter: Pick<BucketStorageAdapter, 'control'> = {
    control: async (op, payload) => {
      calls.push([op, payload])
      return 'ok'
    },
  }
  return { adapter, calls }
}

const bucket = (data: string): SyncDataBucket => ({
  bucket: 'user_data',
  data: [{ op_id: '1', op: 'PUT', object_type: 'tasks', object_id: 't1', checksum: 1, data }],
})

const upperCase: DataTransformMiddleware = {
  transform: (b) => ({ ...b, data: b.data.map((entry) => ({ ...entry, data: entry.data?.toUpperCase() })) }),
}

const entryData = (line: { data: SyncDataBucket }) => line.data.data[0]?.data

describe('installSyncTransformers', () => {
  it('transforms a JSON sync line and re-encodes it as JSON', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [upperCase])

    await adapter.control(PowerSyncControlCommand.PROCESS_TEXT_LINE, JSON.stringify({ data: bucket('{"a":"b"}') }))

    expect(calls).toHaveLength(1)
    const [op, payload] = calls[0]
    expect(op).toBe(PowerSyncControlCommand.PROCESS_TEXT_LINE)
    expect(typeof payload).toBe('string')
    expect(entryData(JSON.parse(payload as string))).toBe('{"A":"B"}')
  })

  it('transforms a BSON sync line and re-encodes it as BSON', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [upperCase])

    await adapter.control(PowerSyncControlCommand.PROCESS_BSON_LINE, bson.serialize({ data: bucket('{"a":"b"}') }))

    expect(calls).toHaveLength(1)
    const [op, payload] = calls[0]
    expect(op).toBe(PowerSyncControlCommand.PROCESS_BSON_LINE)
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(entryData(bson.deserialize(payload as Uint8Array) as { data: SyncDataBucket })).toBe('{"A":"B"}')
  })

  it('runs transformers in registration order', async () => {
    const { adapter, calls } = fakeAdapter()
    const append = (suffix: string): DataTransformMiddleware => ({
      transform: (b) => ({ ...b, data: b.data.map((entry) => ({ ...entry, data: `${entry.data}${suffix}` })) }),
    })
    installSyncTransformers(adapter, [append('-1'), append('-2')])

    await adapter.control(PowerSyncControlCommand.PROCESS_TEXT_LINE, JSON.stringify({ data: bucket('x') }))

    expect(entryData(JSON.parse(calls[0][1] as string))).toBe('x-1-2')
  })

  it('passes lines without bucket data through byte-for-byte', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [upperCase])
    const checkpoint = JSON.stringify({ checkpoint_complete: { last_op_id: '1' } })
    const binaryCheckpoint = bson.serialize({ checkpoint_complete: { last_op_id: '1' } })

    await adapter.control(PowerSyncControlCommand.PROCESS_TEXT_LINE, checkpoint)
    await adapter.control(PowerSyncControlCommand.PROCESS_BSON_LINE, binaryCheckpoint)

    expect(calls).toEqual([
      [PowerSyncControlCommand.PROCESS_TEXT_LINE, checkpoint],
      [PowerSyncControlCommand.PROCESS_BSON_LINE, binaryCheckpoint],
    ])
  })

  it('passes non-line commands through untouched', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [upperCase])

    await adapter.control(PowerSyncControlCommand.START, '{"parameters":{}}')
    await adapter.control(PowerSyncControlCommand.STOP, null)

    expect(calls).toEqual([
      [PowerSyncControlCommand.START, '{"parameters":{}}'],
      [PowerSyncControlCommand.STOP, null],
    ])
  })

  it('never applies a line when a transformer fails', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [
      {
        transform: () => {
          throw new Error('decrypt failed')
        },
      },
    ])

    const line = JSON.stringify({ data: bucket('x') })
    await expect(adapter.control(PowerSyncControlCommand.PROCESS_TEXT_LINE, line)).rejects.toThrow('decrypt failed')
    expect(calls).toEqual([])
  })

  it('refuses a sync line whose payload it cannot parse', async () => {
    const { adapter, calls } = fakeAdapter()
    installSyncTransformers(adapter, [upperCase])

    await expect(adapter.control(PowerSyncControlCommand.PROCESS_BSON_LINE, 'not binary')).rejects.toThrow(
      'unexpected string payload',
    )
    await expect(adapter.control(PowerSyncControlCommand.PROCESS_TEXT_LINE, null)).rejects.toThrow(
      'unexpected null payload',
    )
    expect(calls).toEqual([])
  })
})
