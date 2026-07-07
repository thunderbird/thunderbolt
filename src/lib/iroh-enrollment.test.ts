/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'

import { selfEnrollIrohNodeId } from './iroh-enrollment'

/** A fake app client narrowed to `post` (DI over module mocking). `respond` lets a
 *  single fake resolve or reject the call. */
const fakeClient = (respond: () => Promise<unknown> = async () => new Response()) => {
  const post = mock((_url: string, _options?: unknown) => respond())
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
