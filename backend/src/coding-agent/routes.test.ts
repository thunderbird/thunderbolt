/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the coding-agent WS handlers. They call the exported
 * handleCodingAgent{Open,Message,Close} functions directly against a fake `ws` +
 * injected auth/provision/upstream — no bound port, no DB-backed app, exact close
 * codes. (The real WS-upgrade machinery is exercised repo-wide by
 * haystack/routes.test.ts; spinning a server per close-code here only added CI
 * wall-clock under the 5x backend run.)
 *
 * Close-code contract: 4001 unauthorized, 4002 github-not-connected, 4003
 * provisioning failed / not configured.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { createTestSettings } from '@/test-utils/settings'
import { encodeWsBearer } from '@shared/ws-bearer'
import { describe, expect, it } from 'bun:test'
import type { ProvisionResult } from './provision'
import type { UpstreamSocket } from './proxy'
import {
  createCodingAgentRoutes,
  handleCodingAgentClose,
  handleCodingAgentMessage,
  handleCodingAgentOpen,
  type CodingAgentOpenCtx,
} from './routes'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as CodingAgentOpenCtx['log']
const userAuth = { api: { getSession: async () => ({ user: { id: 'u1', isAnonymous: false } }) } } as unknown as Auth
const fakeUpstream = (): UpstreamSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} })

const bearerHeader = `thunderbolt.v1, thunderbolt.bearer.${encodeWsBearer('tok')}`

const makeWs = (opts: { data?: Record<string, unknown>; subprotocol?: string } = {}) => {
  const request = new Request('http://localhost/v1/coding-agent/ws', {
    headers: { 'sec-websocket-protocol': opts.subprotocol ?? bearerHeader },
  })
  const data: Record<string, unknown> = { request, ...opts.data }
  const sends: string[] = []
  const closes: { code?: number; reason?: string }[] = []
  const ws = {
    data,
    send: (p: string) => sends.push(p),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  }
  return { ws, data, sends, closes }
}

const ctx = (over: Partial<CodingAgentOpenCtx> = {}): CodingAgentOpenCtx => ({
  auth: userAuth,
  settings: createTestSettings({
    codingAgentWorkspaceWsUrl: 'wss://ws.test/?t=x',
    codingAgentBrokerUrl: 'https://broker.test',
    codingAgentServiceToken: 'svc',
  }),
  fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
  log: noopLog,
  provision: async () => ({ status: 'ok' }),
  createUpstream: fakeUpstream,
  ...over,
})

describe('handleCodingAgentOpen — auth', () => {
  it('closes 4001 when no bearer subprotocol is offered', async () => {
    const { ws, closes } = makeWs({ subprotocol: 'thunderbolt.v1' })
    await handleCodingAgentOpen(ws, ctx())
    expect(closes).toEqual([{ code: 4001, reason: 'unauthorized' }])
  })

  it('closes 4001 when the session is unauthenticated', async () => {
    const noUserAuth = { api: { getSession: async () => null } } as unknown as Auth
    const { ws, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ auth: noUserAuth }))
    expect(closes).toEqual([{ code: 4001, reason: 'unauthorized' }])
  })
})

describe('handleCodingAgentOpen — provisioning', () => {
  it("provision 'ok' constructs the proxy and leaves the socket open", async () => {
    const { ws, data, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ provision: async () => ({ status: 'ok' }) }))
    expect(data.proxy).toBeDefined()
    expect(closes).toEqual([])
    handleCodingAgentClose(ws) // dispose → clears the proxy's connect timer
  })

  it("provision 'disabled' proceeds read-only without closing", async () => {
    const { ws, data, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ provision: async () => ({ status: 'disabled' }) }))
    expect(data.proxy).toBeDefined()
    expect(closes).toEqual([])
    handleCodingAgentClose(ws)
  })

  it("provision 'not_connected' closes 4002", async () => {
    const { ws, data, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ provision: async () => ({ status: 'not_connected' }) }))
    expect(closes).toEqual([{ code: 4002, reason: 'github not connected' }])
    expect(data.proxy).toBeUndefined()
  })

  it('a provisioning throw closes 4003', async () => {
    const { ws, data, closes } = makeWs()
    await handleCodingAgentOpen(
      ws,
      ctx({
        provision: async () => {
          throw new Error('broker down')
        },
      }),
    )
    expect(closes).toEqual([{ code: 4003, reason: 'provisioning failed' }])
    expect(data.proxy).toBeUndefined()
  })

  it('an out-of-union provision status hits the exhaustive default and closes 4003', async () => {
    const { ws, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ provision: async () => ({ status: 'bogus' }) as unknown as ProvisionResult }))
    expect(closes).toEqual([{ code: 4003, reason: 'provisioning failed' }])
  })

  it('closes 4003 (not configured) when the workspace endpoint is empty', async () => {
    const { ws, closes } = makeWs()
    await handleCodingAgentOpen(ws, ctx({ settings: createTestSettings({ codingAgentWorkspaceWsUrl: '' }) }))
    expect(closes).toEqual([{ code: 4003, reason: 'coding agent not configured' }])
  })
})

describe('handleCodingAgentOpen — upstream', () => {
  it('client disconnect during open aborts before constructing the upstream', async () => {
    let createUpstreamCalled = false
    const { ws, data, closes } = makeWs({ data: { clientClosed: true } })
    await handleCodingAgentOpen(
      ws,
      ctx({
        createUpstream: () => {
          createUpstreamCalled = true
          return fakeUpstream()
        },
      }),
    )
    expect(createUpstreamCalled).toBe(false)
    expect(data.proxy).toBeUndefined()
    expect(closes).toEqual([])
  })

  it('upstream construction failure closes 4003', async () => {
    const { ws, data, closes } = makeWs()
    await handleCodingAgentOpen(
      ws,
      ctx({
        createUpstream: () => {
          throw new Error('bad url')
        },
      }),
    )
    expect(closes).toEqual([{ code: 4003, reason: 'upstream connect failed' }])
    expect(data.proxy).toBeUndefined()
  })
})

describe('handleCodingAgentMessage / handleCodingAgentClose', () => {
  it('message: no-op when no proxy is attached', () => {
    const { ws } = makeWs()
    expect(() => handleCodingAgentMessage(ws, '{}')).not.toThrow()
  })

  it('message: forwards string frames verbatim and JSON-encodes object frames', () => {
    const received: string[] = []
    const { ws, data } = makeWs()
    data.proxy = { handleClientMessage: (f: string) => received.push(f) }
    handleCodingAgentMessage(ws, 'raw-string')
    handleCodingAgentMessage(ws, { a: 1 })
    expect(received).toEqual(['raw-string', '{"a":1}'])
  })

  it('close: disposes the proxy, marks clientClosed, clears the slot', () => {
    let disposed = 0
    const { ws, data } = makeWs()
    data.proxy = { dispose: () => (disposed += 1) }
    handleCodingAgentClose(ws)
    expect(disposed).toBe(1)
    expect(data.clientClosed).toBe(true)
    expect(data.proxy).toBeUndefined()
  })

  it('close: no-op when no proxy is attached', () => {
    const { ws } = makeWs()
    expect(() => handleCodingAgentClose(ws)).not.toThrow()
  })
})

describe('createCodingAgentRoutes', () => {
  it('mounts the route and exercises the single-shared-workspace WARN branch (broker + workspace set)', () => {
    const settings = createTestSettings({
      codingAgentWorkspaceWsUrl: 'wss://ws.test',
      codingAgentBrokerUrl: 'https://broker.test',
      codingAgentServiceToken: 'svc',
    })
    expect(createCodingAgentRoutes(settings, userAuth)).toBeDefined()
  })

  it('mounts the route without the WARN branch when the coding agent is unconfigured', () => {
    expect(createCodingAgentRoutes(createTestSettings(), userAuth)).toBeDefined()
  })
})
