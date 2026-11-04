/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createBoundConnectionFetch, createConnectionFetch, loadMcpTools, runMcpSetup } from './connections'
import { CloudError } from './errors'
import { createServiceFixture, saveFixtureConnection } from './service-test-fixture'

const binding = {
  id: 'connection',
  userId: 'owner',
  version: 2,
  keyEpoch: 1,
  credentialVersion: 3,
  enabled: true,
  deletedAt: null,
}

/** The upstream spy observes actual dispatch, rather than merely checking an authorization return value. */
const upstream = () => {
  const requests: Request[] = []
  const send = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(new Request(input, init))
    return Response.json({ ok: true })
  }
  return { requests, fetch: Object.assign(send, { preconnect: () => {} }) }
}

describe('MCP captured credential binding', () => {
  it('dispatches only the currently bound token after checking the live grant', async () => {
    const target = upstream()
    const fetch = createBoundConnectionFetch(binding, async () => binding, target.fetch)
    expect((await fetch('https://mcp.example.test', { headers: { authorization: 'Bearer captured-token' } })).ok).toBe(
      true,
    )
    expect(target.requests).toHaveLength(1)
    expect(target.requests[0]!.headers.get('authorization')).toBe('Bearer captured-token')
  })
  it.each([
    { version: 3 },
    { keyEpoch: 2 },
    { credentialVersion: 4 },
    { enabled: false },
    { deletedAt: new Date().toISOString() },
    { userId: 'other-owner' },
    { id: 'other-connection' },
  ])('never dispatches a stale token after grant change %j', async (change) => {
    const target = upstream()
    const fetch = createBoundConnectionFetch(binding, async () => ({ ...binding, ...change }), target.fetch)
    await expect(
      fetch('https://mcp.example.test', { headers: { authorization: 'Bearer captured-token' } }),
    ).rejects.toThrow('connection_grant_changed')
    expect(target.requests).toHaveLength(0)
  })
  it('does not dispatch when refresh fails or authorization has expired', async () => {
    const target = upstream()
    const fetch = createBoundConnectionFetch(
      binding,
      async () => {
        throw new Error('connection_needs_authorization')
      },
      target.fetch,
    )
    await expect(fetch('https://mcp.example.test')).rejects.toThrow('connection_needs_authorization')
    expect(target.requests).toHaveLength(0)
  })
})

describe('optional MCP capabilities', () => {
  it('keeps reachable tools while omitting missing, disabled and unreachable connections', async () => {
    const f = await createServiceFixture()
    const disabled = await saveFixtureConnection(f, { name: 'Disabled tools' }, false)
    const unavailable = await saveFixtureConnection(f, { name: 'Offline tools' })
    const ready = await saveFixtureConnection(f, {
      name: 'Ready tools',
      libraryRef: { kind: 'mcp', id: 'ready-library' },
    })
    const attempted: string[] = []
    const closed: string[] = []
    const missing = crypto.randomUUID()
    const registered = await loadMcpTools(
      f.service,
      f.ownerId,
      f.agentId,
      [missing, disabled.id, unavailable.id, ready.id],
      async (_service, row) => {
        attempted.push(row.id)
        if (row.id === unavailable.id) {
          throw new CloudError(502, 'connection_request_failed')
        }
        return {
          close: async () => {
            closed.push(row.id)
          },
          listTools: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }] }),
          toolsFromDefinitions: () => ({}),
        }
      },
    )
    expect(attempted).toEqual([unavailable.id, ready.id])
    expect(registered.tools.map((tool) => tool.name)).toEqual([`mcp_${ready.id.replaceAll('-', '').slice(0, 12)}_read`])
    expect(registered.unavailable.map((connection) => connection.code)).toEqual([
      'connection_not_found',
      'connection_disabled',
      'connection_request_failed',
    ])
    expect(registered.sourceIds).toEqual(['ready-library'])
    expect(closed).toEqual([])
    await registered.dispose()
    expect(closed).toEqual([ready.id])
  })

  it('closes a rejected connection and never publishes partially validated tool definitions', async () => {
    const f = await createServiceFixture()
    const connection = await saveFixtureConnection(f)
    const closed: string[] = []
    const registered = await loadMcpTools(f.service, f.ownerId, f.agentId, [connection.id], async () => ({
      close: async () => {
        closed.push(connection.id)
      },
      listTools: async () => ({
        tools: [
          { name: 'read', inputSchema: { type: 'object', properties: {} } },
          { name: 'bad tool name', inputSchema: { type: 'object', properties: {} } },
        ],
      }),
      toolsFromDefinitions: () => ({}),
    }))
    expect(registered.tools).toEqual([])
    expect(registered.unavailable[0]?.code).toBe('mcp_tool_definition_invalid')
    expect(closed).toEqual([connection.id])
    await registered.dispose()
    expect(closed).toEqual([connection.id])
  })

  it('propagates database and encryption failures and releases clients already opened', async () => {
    const f = await createServiceFixture()
    const ready = await saveFixtureConnection(f)
    const broken = await saveFixtureConnection(f)
    const failure = new Error('Database unavailable')
    const closed: string[] = []
    await expect(
      loadMcpTools(f.service, f.ownerId, f.agentId, [ready.id, broken.id], async (_service, row) => {
        if (row.id === broken.id) {
          throw failure
        }
        return {
          close: async () => {
            closed.push(row.id)
          },
          listTools: async () => ({ tools: [] }),
          toolsFromDefinitions: () => ({}),
        }
      }),
    ).rejects.toBe(failure)
    expect(closed).toEqual([ready.id])
  })
})

describe('MCP setup failure classification', () => {
  it('maps network-only DNS/HTTP failures to a terminal setup code', async () => {
    const target = upstream()
    const dnsFailure = createConnectionFetch('https://mcp.example.test', target.fetch, async () => {
      throw new Error('DNS failed')
    })
    await expect(dnsFailure('https://mcp.example.test')).rejects.toMatchObject({ code: 'connection_request_failed' })
    expect(target.requests).toHaveLength(0)
    const send = Object.assign(
      async () => {
        throw new Error('Socket lost')
      },
      { preconnect: () => {} },
    )
    const httpFailure = createConnectionFetch('https://mcp.example.test', send, async () => [
      { address: '1.1.1.1', family: 4 },
    ])
    await expect(httpFailure('https://mcp.example.test')).rejects.toMatchObject({ code: 'connection_request_failed' })
  })

  it.each(['MCPClientError', 'AI_MCPClientError', 'AI_TypeValidationError', 'SyntaxError'])(
    'blocks known SDK setup error %s',
    async (name) => {
      const failure = Object.assign(new Error('Provider-controlled details'), { name })
      await expect(
        runMcpSetup(async () => {
          throw failure
        }),
      ).rejects.toMatchObject({ code: 'mcp_setup_failed' })
    },
  )

  it('preserves database/storage failures and explicit grant rejection before any network call', async () => {
    const databaseError = Object.assign(new Error('Database unavailable'), { name: 'DrizzleQueryError' })
    const target = upstream()
    const checked = createBoundConnectionFetch(
      binding,
      async () => {
        throw databaseError
      },
      target.fetch,
    )
    await expect(runMcpSetup(() => checked('https://mcp.example.test'))).rejects.toBe(databaseError)
    expect(target.requests).toHaveLength(0)
    const rejected = new CloudError(409, 'connection_grant_changed')
    await expect(
      runMcpSetup(async () => {
        throw rejected
      }),
    ).rejects.toBe(rejected)
  })
})
