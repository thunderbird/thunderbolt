/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `testAcpConnection` probe tests. We inject a fake transport opener + a fake
 * `ClientSideConnection` constructor via DI — no `mock.module()` of the shared
 * SDK or transport modules (which would leak across files in CI).
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import type { Agent as AcpSdkAgent, Client, InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'
import { encodeWsBearer } from '@shared/ws-bearer'
import { testAcpConnection, type TestAcpConnectionResult } from './connection-test'
import type { AcpTransport } from './types'

/** Read the `webSocketFactory` a mocked `openTransport` was invoked with. */
const factoryPassedTo = (openTransport: unknown): ((url: string) => unknown) | undefined =>
  (openTransport as { mock: { calls: Array<[{ webSocketFactory?: (url: string) => unknown }]> } }).mock.calls[0][0]
    .webSocketFactory

type FakeAgentCapabilities = NonNullable<InitializeResponse['agentCapabilities']>

const buildFakeDeps = (opts: {
  initialize?: (req: InitializeRequest) => Promise<InitializeResponse>
  capabilities?: FakeAgentCapabilities
}) => {
  const close = mock(() => {})
  const stream = {
    writable: new WritableStream(),
    readable: new ReadableStream(),
  }
  const openTransport = mock(async (): Promise<AcpTransport> => ({ stream, close }))

  const initialize =
    opts.initialize ??
    (async (_req: InitializeRequest): Promise<InitializeResponse> => ({
      protocolVersion: 1,
      agentCapabilities: opts.capabilities,
    }))

  class FakeConnection {
    constructor(_toClient: (agent: AcpSdkAgent) => Client, _stream: AcpTransport['stream']) {}
    initialize = initialize
  }

  return { close, openTransport, FakeConnection }
}

describe('testAcpConnection', () => {
  it('returns success with mapped capabilities on a clean handshake', async () => {
    const { close, openTransport, FakeConnection } = buildFakeDeps({
      capabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
    })

    const result = await testAcpConnection({
      url: 'wss://example.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })

    expect(result).toEqual({
      success: true,
      capabilities: {
        loadSession: true,
        skills: false,
        resume: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
    })
    // Transport is always torn down.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('defaults missing capability flags to false', async () => {
    const { openTransport, FakeConnection } = buildFakeDeps({ capabilities: undefined })

    const result = await testAcpConnection({
      url: 'wss://example.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })

    expect(result).toEqual({
      success: true,
      capabilities: {
        loadSession: false,
        skills: false,
        resume: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    })
  })

  it('maps sessionCapabilities.resume presence to resume: true', async () => {
    const { openTransport, FakeConnection } = buildFakeDeps({
      capabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
    })

    const result = await testAcpConnection({
      url: 'wss://example.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })

    expect(result).toMatchObject({ success: true, capabilities: { resume: true, loadSession: false } })
  })

  it('maps Thunderbolt skills capability metadata to skills: true', async () => {
    const { openTransport, FakeConnection } = buildFakeDeps({
      capabilities: {
        _meta: { 'thunderbird.net/thunderbolt': { skills: true } },
      },
    })

    const result = await testAcpConnection({
      url: 'wss://example.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })

    expect(result).toMatchObject({ success: true, capabilities: { skills: true } })
  })

  it('returns the error message when initialize rejects', async () => {
    const { close, openTransport, FakeConnection } = buildFakeDeps({
      initialize: async () => {
        throw new Error('agent refused handshake')
      },
    })

    const result = await testAcpConnection({
      url: 'wss://example.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })

    expect(result).toEqual({ success: false, error: 'agent refused handshake' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('maps a network TypeError to a friendly "Could not reach agent"', async () => {
    const openTransport = mock(async (): Promise<AcpTransport> => {
      throw new TypeError('Failed to fetch')
    })

    const result = await testAcpConnection({
      url: 'wss://unreachable.test/ws',
      openTransport: openTransport as never,
      ClientSideConnection: class {} as never,
    })

    expect(result).toEqual({ success: false, error: 'Could not reach agent' })
  })

  it('returns a timeout error when initialize never resolves', async () => {
    const { close, openTransport, FakeConnection } = buildFakeDeps({
      initialize: () => new Promise<InitializeResponse>(() => {}),
    })

    let resolved: TestAcpConnectionResult | undefined
    const promise = testAcpConnection({
      url: 'wss://slow.test/ws',
      timeoutMs: 5000,
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    }).then((r) => {
      resolved = r
    })

    await act(async () => {
      await getClock().tickAsync(5000)
    })
    await promise

    expect(resolved).toEqual({ success: false, error: 'Connection timed out' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('attaches the carrier + bearer subprotocol for managed-acp agents', async () => {
    const { openTransport, FakeConnection } = buildFakeDeps({ capabilities: {} })
    const created: Array<{ url: string; protocols?: string | string[] }> = []
    const originalWs = globalThis.WebSocket
    class FakeWs {
      constructor(url: string, protocols?: string | string[]) {
        created.push({ url, protocols })
      }
    }
    globalThis.WebSocket = FakeWs as unknown as typeof WebSocket
    try {
      await testAcpConnection({
        url: 'wss://relay.test/v1/openclaw/ws?instance=e2b%3Asbx-1',
        agentType: 'managed-acp',
        getAuthToken: () => 'tok-123',
        openTransport: openTransport as never,
        ClientSideConnection: FakeConnection as never,
      })
      factoryPassedTo(openTransport)?.('wss://relay.test/ws')
      expect(created[0]?.protocols).toEqual(['thunderbolt.v1', `thunderbolt.bearer.${encodeWsBearer('tok-123')}`])
    } finally {
      globalThis.WebSocket = originalWs
    }
  })

  it('connects natively (no bearer factory) for remote-acp agents', async () => {
    const { openTransport, FakeConnection } = buildFakeDeps({ capabilities: {} })
    await testAcpConnection({
      url: 'wss://custom.test/ws',
      agentType: 'remote-acp',
      openTransport: openTransport as never,
      ClientSideConnection: FakeConnection as never,
    })
    // No explicit factory → openWebSocketTransport builds its native default.
    expect(factoryPassedTo(openTransport)).toBeUndefined()
  })
})
