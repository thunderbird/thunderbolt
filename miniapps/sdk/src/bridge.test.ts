/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The guest side of the bridge.
 *
 * This file had no tests at all, and the host-side suite cannot stand in for
 * it: it exercises Thunderbolt's half of the conversation, so guest origin
 * filtering, request/reply disambiguation and disconnect settlement were
 * covered by nothing. Two of them were broken.
 *
 * `window.parent` is the host here. `connect` refuses to run when
 * `window.parent === window`, so each test installs a fake parent that records
 * what the guest posted and can post back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { connect, protocolMarker, readTokenClaims, type Connection } from './bridge'
import { installModelContext, resetModelContextForTests, textResult } from './model-context'
import type { ThunderboltTool } from './tools'

const hostOrigin = 'https://host.example'

type Posted = { id?: number; method?: string; params?: unknown; result?: unknown }

let posted: Posted[] = []
let realParent: Window
/*
 * Every connection made by a test, torn down after it.
 *
 * `connect` installs a `message` listener, and a test that left one attached
 * meant the *next* test's host message was answered by two bridges. That is not
 * hypothetical: it made a context request look like it returned null, because
 * `posted.find` picked the older connection's reply — one made by an app with no
 * `getContext` — over the one under test.
 */
const openConnections: Connection[] = []

/** Connect, and register the result for teardown. */
const track = async (pending: Promise<Connection>): Promise<Connection> => {
  const connection = await pending
  openConnections.push(connection)
  return connection
}

/**
 * Deliver a message as though the host had sent it.
 *
 * `source` is forced after construction: `MessageEvent`'s initialiser only
 * accepts a real `Window`, and the fake parent below is a plain object, so
 * passing it through the constructor silently leaves `source` null and every
 * message fails the bridge's `event.source !== window.parent` guard.
 *
 * `protocol` is added here rather than by each caller because the bridge drops
 * anything without it, and a test that forgot it would look like a logic bug.
 */
const fromHost = (data: Record<string, unknown>, origin = hostOrigin) => {
  const event = new MessageEvent('message', { data: { protocol: protocolMarker, ...data }, origin })
  Object.defineProperty(event, 'source', { value: window.parent, configurable: true })
  window.dispatchEvent(event)
}

/** The id of the last request the guest posted for `method`. */
const lastRequestId = (method: string): number => {
  const match = [...posted].reverse().find((entry) => entry.method === method)
  if (match?.id === undefined) {
    throw new Error(`no request posted for ${method}; saw ${posted.map((p) => p.method).join(', ')}`)
  }
  return match.id
}

/**
 * Let the microtask queue drain.
 *
 * `tools/list` and `tools/call` are answered asynchronously now — both mirror
 * the `tools` option into `document.modelContext` first, and the registry's API
 * is promise-based because native WebMCP's is. So the reply is not in `posted`
 * on the line after the request the way every other handler's is.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  // The registry is module state on the document, so one test's tools would
  // otherwise still be registered in the next.
  resetModelContextForTests()
  posted = []
  realParent = window.parent
  // A distinct object so `window.parent !== window` and `isEmbedded()` passes.
  const fakeParent = {
    postMessage: (payload: Posted) => {
      posted.push(payload)
    },
  }
  Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true, writable: true })
})

afterEach(() => {
  resetModelContextForTests()
  for (const connection of openConnections) {
    connection.disconnect()
  }
  openConnections.length = 0
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true })
})

/** Connect and answer the handshake, returning the live connection. */
const connected = async (): Promise<Connection> => {
  const pending = connect({ appName: 'Test App', hostOrigin, auth: true })
  fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: { hostContext: { theme: 'dark' } } })
  return track(pending)
}

describe('handshake', () => {
  it('posts initialize to the configured host origin and resolves with its context', async () => {
    const connection = await connected()

    expect(connection.hostContext.theme).toBe('dark')
    expect(posted[0]?.method).toBe('ui/initialize')
  })

  it('rejects rather than hanging when nothing is embedding us', async () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true })

    await expect(connect({ appName: 'Test App', hostOrigin })).rejects.toThrow('not embedded')
  })

  it('rejects when the host refuses the handshake', async () => {
    const pending = connect({ appName: 'Test App', hostOrigin })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: { error: { message: 'unknown app' } } })

    await expect(pending).rejects.toThrow('unknown app')
  })
})

describe('origin filtering', () => {
  it('ignores a reply from any origin but the host', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()
    const id = lastRequestId('ui/request-auth-token')

    // Same id, wrong origin: a page that framed us alongside the host must not
    // be able to answer on Thunderbolt's behalf.
    fromHost(
      { jsonrpc: '2.0', id, result: { token: 'forged', expiresAt: '2099-01-01T00:00:00Z' } },
      'https://evil.test',
    )
    fromHost({ jsonrpc: '2.0', id, result: { token: 'real', expiresAt: '2099-01-01T00:00:00Z' } })

    expect((await inFlight)?.token).toBe('real')
  })
})

describe('request lifecycle', () => {
  it('settles a request the host answers with an error', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()

    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/request-auth-token'), error: { message: 'no session' } })

    expect(await inFlight).toBeNull()
  })

  /*
   * The leak. `disconnect()` removed the listener and left `pending` untouched,
   * so nothing could ever answer an in-flight request and the caller's `await`
   * never returned — an unmounted component's token request hung for the life
   * of the page.
   */
  it('settles in-flight requests on disconnect instead of leaving them pending', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()

    connection.disconnect()

    expect(await inFlight).toBeNull()
  })

  it('ignores a reply that arrives after disconnect', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()
    const id = lastRequestId('ui/request-auth-token')

    connection.disconnect()
    fromHost({ jsonrpc: '2.0', id, result: { token: 'late', expiresAt: '2099-01-01T00:00:00Z' } })

    expect(await inFlight).toBeNull()
  })
})

describe('notifications', () => {
  /*
   * Context is pulled, not pushed. The host asks on every `get_app_context`, so
   * state the user changed a moment ago is in the answer without the app having
   * notified anyone (THU-910).
   */
  it('answers a context request with whatever getContext returns now', async () => {
    let view = 'first'
    const pending = connect({ appName: 'Test App', hostOrigin, getContext: () => ({ title: view, summary: 's' }) })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: {} })
    await track(pending)

    view = 'changed since'
    fromHost({ jsonrpc: '2.0', id: 7, method: 'ui/get-context', params: {} })

    const reply = posted.find((entry) => entry.id === 7)
    expect((reply?.result as { context: { title: string } }).context.title).toBe('changed since')
  })

  it('declares the context capability only when an app supplies getContext', async () => {
    await connected()
    const withoutIt = posted.find((entry) => entry.method === 'ui/initialize')
    expect((withoutIt?.params as { capabilities: { context?: boolean } }).capabilities.context).toBe(false)
  })

  /*
   * A throwing `getContext` must still produce a reply: to the host a throw is
   * indistinguishable from a frame that went away, and silence costs the model
   * the whole deadline.
   */
  it('still answers when getContext throws', async () => {
    const pending = connect({
      appName: 'Test App',
      hostOrigin,
      getContext: () => {
        throw new Error('boom')
      },
    })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: {} })
    await track(pending)

    fromHost({ jsonrpc: '2.0', id: 9, method: 'ui/get-context', params: {} })

    expect((posted.find((entry) => entry.id === 9)?.result as { context: unknown }).context).toBeNull()
    expect(posted.some((entry) => entry.method === 'ui/notifications/error')).toBe(true)
  })

  it('truncates a reported error to the length the host accepts', async () => {
    const connection = await connected()

    connection.reportError('x'.repeat(900))

    const report = posted.find((entry) => entry.method === 'ui/notifications/error')
    expect((report?.params as { message: string }).message).toHaveLength(500)
  })
})

/**
 * Tools reach the host out of `document.modelContext` — native WebMCP where the
 * browser has it, our shim otherwise (see `model-context.ts`). Both spellings
 * land in the same registry, and these cover the seam between them.
 */
describe('tools', () => {
  const highlight = (label: string): ThunderboltTool => ({
    name: 'highlight',
    description: 'Highlights a row.',
    execute: () => `highlighted ${label}`,
  })

  /** Connect with a `tools` option and answer the handshake. */
  const connectedWithTools = async (tools: ThunderboltTool[] | (() => ThunderboltTool[])): Promise<Connection> => {
    const pending = connect({ appName: 'Test App', hostOrigin, tools })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: {} })
    return track(pending)
  }

  it('declares the capability when the app passes tools', async () => {
    await connectedWithTools([highlight('a')])

    const handshake = posted.find((entry) => entry.method === 'ui/initialize')
    expect((handshake?.params as { capabilities: { tools: boolean } }).capabilities.tools).toBe(true)
  })

  it('lists the tools the app passed', async () => {
    await connectedWithTools([highlight('a')])

    fromHost({ jsonrpc: '2.0', id: 20, method: 'tools/list', params: {} })
    await flush()

    const listed = (posted.find((entry) => entry.id === 20)?.result as { tools: unknown[] }).tools
    expect(listed).toEqual([{ name: 'highlight', description: 'Highlights a row.' }])
  })

  it('runs one and answers with its text', async () => {
    await connectedWithTools([highlight('row-3')])

    fromHost({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'highlight', arguments: {} } })
    await flush()

    expect(posted.find((entry) => entry.id === 21)?.result).toEqual({ content: 'highlighted row-3' })
  })

  /*
   * The reason the `tools` option is mirrored on every list and call rather than
   * registered once: a React app rebuilds its tool array each render so the
   * closures see current state, and a descriptor captured at connect would
   * invoke against state frozen at mount.
   */
  it('invokes against the current array, not the one present at connect', async () => {
    let label = 'before'
    await connectedWithTools(() => [highlight(label)])

    label = 'after'
    fromHost({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'highlight', arguments: {} } })
    await flush()

    expect(posted.find((entry) => entry.id === 22)?.result).toEqual({ content: 'highlighted after' })
  })

  it('stops listing a tool the app dropped from the array', async () => {
    let tools = [highlight('a')]
    await connectedWithTools(() => tools)

    tools = []
    fromHost({ jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} })
    await flush()

    expect((posted.find((entry) => entry.id === 23)?.result as { tools: unknown[] }).tools).toEqual([])
  })

  it('reports an unknown tool as an error result rather than silence', async () => {
    await connectedWithTools([highlight('a')])

    fromHost({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'ghost', arguments: {} } })
    await flush()

    const result = posted.find((entry) => entry.id === 24)?.result as { content: string; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content).toContain('No tool named "ghost"')
  })

  it("answers with an error result when the app's tool throws", async () => {
    await connectedWithTools([
      {
        name: 'explode',
        description: 'Always throws.',
        execute: () => {
          throw new Error('nope')
        },
      },
    ])

    fromHost({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'explode', arguments: {} } })
    await flush()

    expect(posted.find((entry) => entry.id === 25)?.result).toEqual({ content: 'nope', isError: true })
  })

  describe('registered through document.modelContext', () => {
    it('lists a tool the app registered directly', async () => {
      const connection = await connectedWithTools([])
      await installModelContext().modelContext.registerTool({
        name: 'native_style',
        description: 'Registered the canonical way.',
        execute: () => textResult('done'),
      })

      fromHost({ jsonrpc: '2.0', id: 26, method: 'tools/list', params: {} })
      await flush()

      const listed = (posted.find((entry) => entry.id === 26)?.result as { tools: Array<{ name: string }> }).tools
      expect(listed.map((tool) => tool.name)).toEqual(['native_style'])
      expect(connection.hostContext.theme).toBe('light')
    })

    /*
     * The whole reason `ui/notifications/tools-changed` exists. The host asks
     * for tools once, right after the handshake; the canonical way to register
     * is a call in an effect, which runs after that. Without the nudge the tool
     * is in the page and invisible to the model, with nothing to say why.
     */
    it('tells the host to re-list when a tool appears after the handshake', async () => {
      await connectedWithTools([])
      expect(posted.some((entry) => entry.method === 'ui/notifications/tools-changed')).toBe(false)

      await installModelContext().modelContext.registerTool({
        name: 'late',
        description: 'Registered in an effect.',
        execute: () => textResult('done'),
      })

      expect(posted.some((entry) => entry.method === 'ui/notifications/tools-changed')).toBe(true)
    })

    /*
     * The other order, and it does not fire an event we can hear: the shim
     * installs at import, so an app can register before `connect()` runs, and
     * that `toolchange` goes to a registry with no listener attached yet.
     */
    it('announces tools that were registered before connect', async () => {
      await installModelContext().modelContext.registerTool({
        name: 'early',
        description: 'Registered at module scope.',
        execute: () => textResult('done'),
      })

      await connectedWithTools([])
      await flush()

      expect(posted.some((entry) => entry.method === 'ui/notifications/tools-changed')).toBe(true)
    })

    /*
     * Mirroring the `tools` option is itself a registry change, so without the
     * suppression each `tools/list` would announce a change and the host would
     * list again — answering that list would announce again, and so on.
     */
    it('does not announce the changes its own mirroring makes', async () => {
      await connectedWithTools([highlight('a')])

      fromHost({ jsonrpc: '2.0', id: 27, method: 'tools/list', params: {} })
      await flush()

      expect(posted.some((entry) => entry.method === 'ui/notifications/tools-changed')).toBe(false)
    })

    it('stops announcing once disconnected', async () => {
      const connection = await connectedWithTools([])
      connection.disconnect()
      posted = []

      await installModelContext().modelContext.registerTool({
        name: 'after_teardown',
        description: 'Nobody is listening.',
        execute: () => textResult('done'),
      })

      expect(posted).toEqual([])
    })
  })
})

/**
 * The guest mints an id for its own document, because the host cannot tell the
 * frame's documents apart: a cross-origin `load` event carries no identity, and
 * the order `initialize` arrives in does not imply which document sent it
 * (THU-908).
 */
describe('document identity', () => {
  it('sends a document id with the handshake', async () => {
    await connected()

    const handshake = posted.find((entry) => entry.method === 'ui/initialize')
    const { documentId } = (handshake?.params as { documentId: string }) ?? {}
    expect(typeof documentId).toBe('string')
    expect(documentId.length).toBeGreaterThan(0)
  })

  it('answers ui/identify with that same id', async () => {
    await connected()
    const handshake = posted.find((entry) => entry.method === 'ui/initialize')

    fromHost({ jsonrpc: '2.0', id: 40, method: 'ui/identify', params: {} })

    expect(posted.find((entry) => entry.id === 40)?.result).toEqual({
      documentId: (handshake?.params as { documentId: string }).documentId,
    })
  })

  /*
   * Answering at all is most of the signal — the host reads silence as "the
   * document that just committed has not introduced itself" — so a second
   * `connect()` in the same document must not invent a new identity, or a
   * reload would look like a navigation.
   */
  it('keeps one id across two connections in the same document', async () => {
    await connected()
    const first = posted.find((entry) => entry.method === 'ui/initialize')
    posted.length = 0

    const pending = connect({ appName: 'Test App', hostOrigin })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: {} })
    await track(pending)

    const second = posted.find((entry) => entry.method === 'ui/initialize')
    expect((second?.params as { documentId: string }).documentId).toBe(
      (first?.params as { documentId: string }).documentId,
    )
  })
})

describe('readTokenClaims', () => {
  /** base64url over UTF-8, the way a real issuer encodes a payload. */
  const encodePayload = (claims: Record<string, unknown>) => {
    const utf8 = new TextEncoder().encode(JSON.stringify(claims))
    const binary = String.fromCharCode(...utf8)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /*
   * `atob` yields one char per byte, so a Latin-1 read of a UTF-8 payload
   * mangled any non-ASCII name — and silently, because the mangled bytes are
   * still valid JSON. Exactly the case this function documents itself as being
   * for: putting a name in the corner of the UI.
   */
  it('decodes a non-ASCII name rather than mojibake', () => {
    const token = `header.${encodePayload({ name: 'Jürgen Müller', email: 'jm@example.de' })}.signature`

    expect(readTokenClaims(token)?.name).toBe('Jürgen Müller')
  })

  it('decodes a non-Latin name', () => {
    const token = `header.${encodePayload({ name: '田中太郎', email: 't@example.jp' })}.signature`

    expect(readTokenClaims(token)?.name).toBe('田中太郎')
  })

  it('returns null for a token with no payload segment', () => {
    expect(readTokenClaims('nonsense')).toBeNull()
  })

  it('returns null rather than throwing on a payload that is not JSON', () => {
    expect(readTokenClaims('header.bm90LWpzb24.signature')).toBeNull()
  })
})
