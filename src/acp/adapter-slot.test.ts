/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { AdapterSlot } from './adapter-slot'

type FakeAdapter = {
  closed?: Promise<void>
  disconnect: () => void
  id: string
}

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const buildAdapter = (id: string, closed?: Promise<void>) => ({
  id,
  closed,
  disconnect: mock(() => {}),
})

describe('AdapterSlot', () => {
  it('moves connecting → ready → terminated and reports the generation', async () => {
    const transport = deferred<void>()
    const connect = deferred<FakeAdapter>()
    const onTerminated = mock(() => {})
    const slot = new AdapterSlot<FakeAdapter>({ onTerminated })
    const pending = slot.getOrConnect(() => connect.promise)

    expect(slot.status).toBe('connecting')
    expect(slot.generation).toBe(1)
    const adapter = buildAdapter('first', transport.promise)
    connect.resolve(adapter)
    await expect(pending).resolves.toBe(adapter)
    expect(slot.status).toBe('ready')

    transport.reject(new Error('dropped'))
    await Promise.resolve()
    expect(slot.status).toBe('terminated')
    expect(adapter.disconnect).toHaveBeenCalledTimes(1)
    expect(onTerminated).toHaveBeenCalledWith({ generation: 1, error: expect.any(Error) })
  })

  it('shares one rebuild across concurrent callers', async () => {
    const connect = deferred<FakeAdapter>()
    const connectCalls = mock(() => connect.promise)
    const slot = new AdapterSlot<FakeAdapter>()

    const first = slot.getOrConnect(connectCalls)
    const second = slot.getOrConnect(connectCalls)
    expect(first).toBe(second)
    expect(connectCalls).toHaveBeenCalledTimes(1)

    const adapter = buildAdapter('shared')
    connect.resolve(adapter)
    await expect(Promise.all([first, second])).resolves.toEqual([adapter, adapter])
  })

  it('ignores a stale generation termination after its replacement is ready', async () => {
    const firstClosed = deferred<void>()
    const slot = new AdapterSlot<FakeAdapter>()
    await slot.getOrConnect(async () => buildAdapter('first', firstClosed.promise))
    const firstGeneration = slot.generation
    firstClosed.resolve()
    await Promise.resolve()

    const second = buildAdapter('second')
    await slot.getOrConnect(async () => second)
    expect(slot.generation).toBe(2)
    expect(slot.terminateGeneration(firstGeneration, new Error('late'))).toBe(false)
    await expect(slot.getOrConnect(async () => buildAdapter('third'))).resolves.toBe(second)
  })

  it('disconnects a generation that resolves after disposal', async () => {
    const connect = deferred<FakeAdapter>()
    const slot = new AdapterSlot<FakeAdapter>()
    const pending = slot.getOrConnect(() => connect.promise)
    const disposing = slot.dispose()
    const adapter = buildAdapter('late')
    connect.resolve(adapter)

    await disposing
    await expect(pending).rejects.toThrow('superseded')
    expect(adapter.disconnect).toHaveBeenCalledTimes(1)
    expect(slot.status).toBe('terminated')
  })

  it('leaves a rejected rebuild terminated so the next call retries', async () => {
    const slot = new AdapterSlot<FakeAdapter>()
    await expect(slot.getOrConnect(async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    expect(slot.status).toBe('terminated')

    const adapter = buildAdapter('retry')
    await expect(slot.getOrConnect(async () => adapter)).resolves.toBe(adapter)
    expect(slot.status).toBe('ready')
    expect(slot.generation).toBe(2)
  })
})
