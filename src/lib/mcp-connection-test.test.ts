/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { probeMcpServerTools, type McpTransport } from './mcp-connection-test'

const dummyTransport = {} as McpTransport

/** The minimal client surface `probeMcpServerTools` actually uses. */
type FakeClient = { tools: () => Promise<Record<string, unknown>>; close: () => Promise<void> }

/**
 * Builds a fake client factory whose `tools()` is supplied by the test, and
 * exposes `closed()` so a test can assert the client was closed. The fake's
 * shape is type-checked via {@link FakeClient}; only the factory is cast.
 */
const fakeClientFactory = (
  tools: FakeClient['tools'],
): { create: Parameters<typeof probeMcpServerTools>[1]; closed: () => boolean } => {
  let closed = false
  const client: FakeClient = {
    tools,
    close: async () => {
      closed = true
    },
  }
  const create = (async () => client) as unknown as Parameters<typeof probeMcpServerTools>[1]
  return { create, closed: () => closed }
}

describe('probeMcpServerTools', () => {
  it('returns the server tool names', async () => {
    const { create } = fakeClientFactory(async () => ({ search: {}, fetch: {} }))
    expect(await probeMcpServerTools(dummyTransport, create)).toEqual(['search', 'fetch'])
  })

  it('returns an empty array when the server exposes no tools', async () => {
    const { create } = fakeClientFactory(async () => ({}))
    expect(await probeMcpServerTools(dummyTransport, create)).toEqual([])
  })

  it('closes the client on success', async () => {
    const { create, closed } = fakeClientFactory(async () => ({ a: {} }))
    await probeMcpServerTools(dummyTransport, create)
    expect(closed()).toBe(true)
  })

  it('closes the client even when listing tools throws, then rethrows', async () => {
    const { create, closed } = fakeClientFactory(async () => {
      throw new Error('boom')
    })
    await expect(probeMcpServerTools(dummyTransport, create)).rejects.toThrow('boom')
    expect(closed()).toBe(true)
  })
})
