/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'

import { enrollIrohBridge, selfEnrollIrohNodeId } from './iroh-enrollment'

/** A fake app client narrowed to `post` (DI over module mocking). `respond` receives the
 *  posted url so a single fake can resolve or reject per route. */
const fakeClient = (respond: (url: string) => Promise<unknown> = async () => new Response()) => {
  const post = mock((url: string, _options?: unknown) => respond(url))
  return { client: { post } as unknown as Parameters<typeof selfEnrollIrohNodeId>[0], post }
}

describe('selfEnrollIrohNodeId', () => {
  it('posts the app node id to the self-enroll route', async () => {
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

describe('enrollIrohBridge', () => {
  it('self-enrolls the app node id and registers the bridge, in that order', async () => {
    const { client, post } = fakeClient()

    await enrollIrohBridge(client, { target: 'bridge-node', name: 'Laptop Bridge' }, async () => 'app-node')

    expect(post).toHaveBeenCalledTimes(2)
    // Step 1: self-enroll this app's dialer NodeId (the write that grants auto-trust).
    expect(post).toHaveBeenNthCalledWith(1, 'devices/me/node-id', { json: { nodeId: 'app-node' } })
    // Step 2: register the bridge itself (server sets device_type='bridge').
    expect(post).toHaveBeenNthCalledWith(2, 'devices/bridge', {
      json: { nodeId: 'bridge-node', name: 'Laptop Bridge' },
    })
  })

  it('trims the target before registering the bridge (the raw ticket the transport dials)', async () => {
    const { client, post } = fakeClient()

    await enrollIrohBridge(client, { target: '  bridge-node\n', name: 'Bridge' }, async () => 'app-node')

    expect(post).toHaveBeenNthCalledWith(2, 'devices/bridge', { json: { nodeId: 'bridge-node', name: 'Bridge' } })
  })

  it('does not register the bridge when self-enroll fails', async () => {
    const { client, post } = fakeClient(async (url) => {
      if (url === 'devices/me/node-id') {
        throw new Error('no account')
      }
      return new Response()
    })

    await expect(
      enrollIrohBridge(client, { target: 'bridge-node', name: 'Bridge' }, async () => 'app-node'),
    ).rejects.toThrow('no account')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'app-node' } })
  })

  it('propagates a failed bridge registration so the caller falls back to manual pairing', async () => {
    const { client } = fakeClient(async (url) => {
      if (url === 'devices/bridge') {
        throw new Error('bridge offline')
      }
      return new Response()
    })

    await expect(
      enrollIrohBridge(client, { target: 'bridge-node', name: 'Bridge' }, async () => 'app-node'),
    ).rejects.toThrow('bridge offline')
  })
})
