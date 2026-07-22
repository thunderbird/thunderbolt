/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { devicesTable } from '@/db/tables'
import { ensureSelfEnrollment, resetSelfEnrollmentForTests, selfEnrollIrohNodeId } from './iroh-enrollment'

/** A fake app client narrowed to `post` (DI over module mocking). `respond` receives the
 *  posted url so a single fake can resolve or reject per route. */
const fakeClient = (respond: (url: string) => Promise<unknown> = async () => new Response()) => {
  const post = mock((url: string, _options?: unknown) => respond(url))
  return { client: { post } as unknown as Parameters<typeof selfEnrollIrohNodeId>[0], post }
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterEach(async () => {
  resetSelfEnrollmentForTests()
  localStorage.removeItem('thunderbolt_device_id')
  await resetTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('selfEnrollIrohNodeId', () => {
  it('posts only the app node id to the self-enroll route', async () => {
    const { client, post } = fakeClient()

    await selfEnrollIrohNodeId(client, async () => 'node-abc')

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'node-abc' } })
  })

  it('reads the node id from the injected loader before posting', async () => {
    const { client, post } = fakeClient()
    const loadNodeId = mock(async () => 'lazy-node')

    await selfEnrollIrohNodeId(client, loadNodeId)

    expect(loadNodeId).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'lazy-node' } })
  })

  it('propagates a failed post so the caller can fall back to manual pairing', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('no account')
    })

    await expect(selfEnrollIrohNodeId(client, async () => 'node-abc')).rejects.toThrow('no account')
  })

  it('does not post when the node id cannot be loaded', async () => {
    const { client, post } = fakeClient()

    await expect(
      selfEnrollIrohNodeId(client, async () => {
        throw new Error('wasm unavailable')
      }),
    ).rejects.toThrow('wasm unavailable')
    expect(post).not.toHaveBeenCalled()
  })
})

describe('ensureSelfEnrollment', () => {
  it('enrolls a synced device whose own row has no node id, then memoizes the enrollment', async () => {
    const { client, post } = fakeClient()
    const loadNodeId = mock(async () => 'node-abc')
    const loadOwnNodeId = mock(async () => null)
    const loadDeviceId = () => 'device-1'

    await ensureSelfEnrollment(client, loadNodeId, { loadOwnNodeId, loadDeviceId })
    await ensureSelfEnrollment(client, loadNodeId, { loadOwnNodeId, loadDeviceId })

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'node-abc' } })
    expect(loadOwnNodeId).toHaveBeenCalledTimes(1)
  })

  it('skips enrollment when the own device row matches the current identity', async () => {
    const { client, post } = fakeClient()

    await ensureSelfEnrollment(client, async () => 'node-abc', {
      loadOwnNodeId: async () => 'node-abc',
      loadDeviceId: () => 'device-1',
    })

    expect(post).not.toHaveBeenCalled()
  })

  it('enrolls when the own device row contains a stale node id', async () => {
    const { client, post } = fakeClient()

    await ensureSelfEnrollment(client, async () => 'node-current', {
      loadOwnNodeId: async () => 'node-stale',
      loadDeviceId: () => 'device-1',
    })

    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'node-current' } })
  })

  it('attempts enrollment only once per session when the own-row lookup rejects', async () => {
    const { client, post } = fakeClient(async () => {
      throw new Error('403')
    })
    const unavailableLookup = async (): Promise<string | null | undefined> => {
      throw new Error('sync unavailable')
    }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await ensureSelfEnrollment(client, async () => 'node-abc', {
        loadOwnNodeId: unavailableLookup,
        loadDeviceId: () => 'device-1',
      })
      await ensureSelfEnrollment(client, async () => 'node-abc', {
        loadOwnNodeId: unavailableLookup,
        loadDeviceId: () => 'device-1',
      })

      expect(post).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('deduplicates concurrent enrollment for the same device identity', async () => {
    const { client, post } = fakeClient()
    const deps = {
      loadOwnNodeId: async () => null,
      loadDeviceId: () => 'device-1',
    }

    await Promise.all([
      ensureSelfEnrollment(client, async () => 'node-abc', deps),
      ensureSelfEnrollment(client, async () => 'node-abc', deps),
    ])

    expect(post).toHaveBeenCalledTimes(1)
  })

  it('memoizes enrollment per device, not only per node id', async () => {
    const { client, post } = fakeClient()

    await ensureSelfEnrollment(client, async () => 'node-abc', {
      loadOwnNodeId: async () => null,
      loadDeviceId: () => 'device-1',
    })
    await ensureSelfEnrollment(client, async () => 'node-abc', {
      loadOwnNodeId: async () => null,
      loadDeviceId: () => 'device-2',
    })

    expect(post).toHaveBeenCalledTimes(2)
  })

  it('uses the current X-Device-ID source to read the own device row', async () => {
    localStorage.setItem('thunderbolt_device_id', 'device-1')
    await getDb().insert(devicesTable).values({
      id: 'device-1',
      userId: 'user-1',
      name: 'Synced device',
      nodeId: null,
    })
    const { client, post } = fakeClient()

    await ensureSelfEnrollment(client, async () => 'node-abc')

    expect(post).toHaveBeenCalledTimes(1)
  })
})
