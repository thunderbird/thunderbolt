/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { MCPClient } from '@ai-sdk/mcp'
import type { Tool } from 'ai'
import { mergeMcpTools } from './fetch'

/** Mirror the `MCPClientError` the SDK throws after a transport drop. The
 *  runtime instance `name` is `'MCPClientError'` (the `AI_MCPClientError`
 *  constant is only the marker symbol). */
const closedError = (message = 'Connection closed') => Object.assign(new Error(message), { name: 'MCPClientError' })

/** A `Tool` is opaque to `mergeMcpTools` (it only spreads the map), so a tagged
 *  sentinel is enough to assert which client's tools landed in the result. */
const tool = (tag: string): Tool => ({ tag }) as unknown as Tool

/** Minimal fake satisfying the slice of `MCPClient` that `mergeMcpTools` uses. */
const fakeClient = (tools: () => Promise<Record<string, Tool>>): MCPClient =>
  ({ tools, close: () => {} }) as unknown as MCPClient

describe('mergeMcpTools', () => {
  it('merges tools from every client — no reconnect on the happy path', async () => {
    const a = fakeClient(async () => ({ alpha: tool('a') }))
    const b = fakeClient(async () => ({ beta: tool('b') }))
    const reconnect = mock(async () => null)

    const merged = await mergeMcpTools({}, [a, b], reconnect)

    expect(Object.keys(merged).sort()).toEqual(['alpha', 'beta'])
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('skips a tool whose name collides with an earlier MCP server (first-registered wins)', async () => {
    const a = fakeClient(async () => ({ shared: tool('from-a') }))
    const b = fakeClient(async () => ({ shared: tool('from-b'), beta: tool('b') }))

    const merged = await mergeMcpTools({}, [a, b], async () => null)

    expect(merged.shared).toEqual(tool('from-a'))
    expect(Object.keys(merged).sort()).toEqual(['beta', 'shared'])
  })

  it('skips a tool that collides with a pre-seeded built-in tool and keeps the built-in', async () => {
    const builtIn = tool('built-in')
    const toolset = { search: builtIn }
    const a = fakeClient(async () => ({ search: tool('from-mcp'), beta: tool('b') }))

    const merged = await mergeMcpTools(toolset, [a], async () => null)

    // Same object mutated in place and returned; the built-in wins the collision.
    expect(merged).toBe(toolset)
    expect(merged.search).toBe(builtIn)
    expect(Object.keys(merged).sort()).toEqual(['beta', 'search'])
  })

  it('reconnects once and retries when tools() throws a closed-connection error', async () => {
    let calls = 0
    const dropped = fakeClient(async () => {
      calls++
      throw closedError()
    })
    const fresh = fakeClient(async () => ({ alpha: tool('fresh') }))
    const reconnect = mock(async () => fresh)

    const merged = await mergeMcpTools({}, [dropped], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(reconnect).toHaveBeenCalledWith(dropped)
    expect(calls).toBe(1)
    expect(merged.alpha).toEqual(tool('fresh'))
  })

  it('skips the dropped server but still merges the others when reconnect fails (non-blocking)', async () => {
    const dropped = fakeClient(async () => {
      throw closedError('Attempted to send a request from a closed client')
    })
    const healthy = fakeClient(async () => ({ beta: tool('b') }))
    const reconnect = mock(async () => null)

    const merged = await mergeMcpTools({}, [dropped, healthy], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(Object.keys(merged)).toEqual(['beta'])
  })

  it('skips the server when the fresh client also fails after reconnect', async () => {
    const dropped = fakeClient(async () => {
      throw closedError()
    })
    const stillBroken = fakeClient(async () => {
      throw closedError()
    })
    const healthy = fakeClient(async () => ({ beta: tool('b') }))
    const reconnect = mock(async () => stillBroken)

    const merged = await mergeMcpTools({}, [dropped, healthy], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(Object.keys(merged)).toEqual(['beta'])
  })

  it('does not reconnect and propagates non-closed errors', async () => {
    const boom = new Error('boom — capability missing')
    const broken = fakeClient(async () => {
      throw boom
    })
    const reconnect = mock(async () => null)

    await expect(mergeMcpTools({}, [broken], reconnect)).rejects.toThrow('boom — capability missing')
    expect(reconnect).not.toHaveBeenCalled()
  })
})
