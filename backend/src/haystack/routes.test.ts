/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth-gate tests for the Haystack WebSocket endpoint. The route only matters
 * once a real ws upgrade lands, so the suite spins up Elysia on an ephemeral
 * port and connects with Bun's WebSocket.
 *
 * Auth contract:
 *  - No bearer in `Sec-WebSocket-Protocol` → close 4001.
 *  - Invalid / garbage bearer → close 4001.
 *  - Anonymous user's bearer → close 4001.
 *  - Valid bearer → ws opens, initialize succeeds, only `thunderbolt.v1` echoed.
 *
 * The session-cookie fallback that used to live in `beforeHandle` was removed:
 * the production WS client always opens with `credentials: 'omit'`, so the
 * cookie path was dead code. Auth runs in `open()` (not `beforeHandle`) because
 * Bun's adapter can call `beforeHandle` more than once per upgrade. The bearer
 * is validated via the same Better Auth path REST uses (HMAC + DB lookup).
 */

import { user as userTable, session as sessionTable } from '@/db/auth-schema'
import { createApp } from '@/index'
import { createTestApp } from '@/test-utils/e2e'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { clearSettingsCache } from '@/config/settings'
import { encodeWsBearer } from '@shared/ws-bearer'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'

/** Sign a raw session token the way Better Auth's bearer plugin does. */
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

type RunningApp = {
  listen: (port: { port: number; hostname?: string }, callback?: () => void) => unknown
  stop: (closeActiveConnections?: boolean) => Promise<void> | void
  server: { port: number } | null
}

const startApp = async (app: RunningApp): Promise<number> => {
  await new Promise<void>((resolve) => {
    app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  return app.server!.port
}

const stopApp = async (app: RunningApp): Promise<void> => {
  await Promise.race([Promise.resolve(app.stop(true)), new Promise((r) => setTimeout(r, 500))])
}

/** Wait until the WS observes `close` or `error`, returning the close info. */
const observeWsTermination = (ws: WebSocket): Promise<{ code: number; reason: string; errored: boolean }> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (code: number, reason: string, errored: boolean) => {
      if (settled) {
        return
      }
      settled = true
      resolve({ code, reason, errored })
    }
    ws.addEventListener('close', (event: CloseEvent) => finish(event.code, event.reason, false))
    ws.addEventListener('error', () => finish(0, '', true))
  })

/** Wait for a single message from the socket. Used to assert initialize. */
const nextMessage = (ws: WebSocket): Promise<string> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup()
      resolve(typeof event.data === 'string' ? event.data : '')
    }
    const onError = () => {
      cleanup()
      reject(new Error('socket errored before message'))
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket closed before message'))
    }
    const cleanup = () => {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
  })

const bearerProtocols = (bearerToken: string): string[] => [
  'thunderbolt.v1',
  `thunderbolt.bearer.${encodeWsBearer(bearerToken)}`,
]

/**
 * Fake Deepset for the WS resolver (`resolveHaystackPipeline` → `GET /pipelines/:name`):
 * `rag` resolves to a deployed pipeline; everything else 404s → the route closes 4001.
 * Injected as `createApp`'s `fetchFn`, so it only affects the live slug lookup.
 */
const haystackFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (/\/pipelines\/rag$/.test(url)) {
    return new Response(JSON.stringify({ name: 'rag', pipeline_id: 'pipe-uuid', status: 'DEPLOYED' }), { status: 200 })
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found' })
}) as typeof fetch

/**
 * Same as {@link haystackFetch} but the slug lookup is deliberately slow, so the
 * server-side async `open()` is still resolving when the client's first frame
 * lands — the production condition (a real Deepset lookup takes tens of ms) that
 * a synchronous fake hides. Exercises the early-frame buffering.
 */
const slowHaystackFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (/\/pipelines\/rag$/.test(url)) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    return new Response(JSON.stringify({ name: 'rag', pipeline_id: 'pipe-uuid', status: 'DEPLOYED' }), { status: 200 })
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found' })
}) as typeof fetch

describe('WS /v1/haystack/ws — auth gating', () => {
  const cleanups: Array<() => Promise<void>> = []
  // Isolated PGlite instance for the real-`.listen()` upgrades in this suite:
  // their server-side getSession reads must not race the shared BEGIN/ROLLBACK
  // singleton (head-of-line blocking under CI starvation; the 5s `initialize`
  // timeout was the canary). Closed once in afterAll to avoid exit-99.
  let iso: IsolatedTestDb
  // Real settings come from `getSettings()` which reads `process.env`. Point
  // Haystack at a fake host so it's "configured"; the route's live slug→pipeline
  // lookup is served by the injected `haystackFetch` (otherwise even
  // authenticated upgrades would close 4001 with "unknown pipeline").
  const originalBaseUrlEnv = process.env.HAYSTACK_BASE_URL
  const originalApiKeyEnv = process.env.HAYSTACK_API_KEY
  const originalWorkspaceEnv = process.env.HAYSTACK_WORKSPACE

  beforeAll(async () => {
    iso = await getSharedIsolatedTestDb()
  })

  beforeEach(() => {
    process.env.HAYSTACK_BASE_URL = 'https://haystack.test'
    process.env.HAYSTACK_API_KEY = 'sk-test'
    process.env.HAYSTACK_WORKSPACE = 'ws-test'
    clearSettingsCache()
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    if (originalBaseUrlEnv === undefined) {
      delete process.env.HAYSTACK_BASE_URL
    } else {
      process.env.HAYSTACK_BASE_URL = originalBaseUrlEnv
    }
    if (originalApiKeyEnv === undefined) {
      delete process.env.HAYSTACK_API_KEY
    } else {
      process.env.HAYSTACK_API_KEY = originalApiKeyEnv
    }
    if (originalWorkspaceEnv === undefined) {
      delete process.env.HAYSTACK_WORKSPACE
    } else {
      process.env.HAYSTACK_WORKSPACE = originalWorkspaceEnv
    }
    clearSettingsCache()
  })

  it('closes 4001 when no subprotocol (and therefore no bearer) is offered', async () => {
    const handle = await createTestApp({ database: iso.db })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`)
    const term = await observeWsTermination(client)
    // Bun's native ws may surface either the application close (4001) or a
    // pre-upgrade abnormal (1006) depending on how the upgrade resolves.
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when only the carrier subprotocol is offered (no bearer entry)', async () => {
    const handle = await createTestApp({ database: iso.db })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    // The server echoes `thunderbolt.v1`, so the upgrade succeeds; auth in
    // `open()` then rejects because no bearer subprotocol entry was offered.
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, ['thunderbolt.v1'])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when the bearer subprotocol contains a garbage token', async () => {
    const handle = await createTestApp({ database: iso.db })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`,
      bearerProtocols('not-a-real.signed-token'),
    )
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 for an anonymous user even with a validly-signed bearer', async () => {
    const app = await createApp({ database: iso.db })
    const port = await startApp(app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(app as unknown as RunningApp)
    })

    const userId = `anon-${crypto.randomUUID()}`
    const sessionToken = `anon-session-${crypto.randomUUID()}`
    const now = new Date()
    await iso.db.insert(userTable).values({
      id: userId,
      name: 'Anon',
      email: `${userId}@anon.test`,
      emailVerified: false,
      isAnonymous: true,
      createdAt: now,
      updatedAt: now,
    })
    await iso.db.insert(sessionTable).values({
      id: `anon-session-row-${userId}`,
      token: sessionToken,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      userId,
      createdAt: now,
      updatedAt: now,
    })

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`,
      bearerProtocols(signToken(sessionToken)),
    )
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('opens the socket and answers initialize when a valid bearer is offered', async () => {
    const handle = await createTestApp({ database: iso.db, fetchFn: haystackFetch })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`,
      bearerProtocols(handle.bearerToken),
    )
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('close', () => reject(new Error('closed before open')))
      client.addEventListener('error', () => reject(new Error('errored before open')))
    })

    // Browser sees only the carrier subprotocol — never the auth-bearing one.
    expect(client.protocol).toBe('thunderbolt.v1')

    // Bind the reply listener BEFORE send so no message is missed (mandatory:
    // `nextMessage` otherwise binds after send — the same late-bind race fixed
    // elsewhere). With the isolated DB the server-side bearer verify no longer
    // races the shared singleton, so this resolves in single-digit ms.
    const replyPromise = nextMessage(client)
    client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
    const raw = await replyPromise
    const reply = JSON.parse(raw)
    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBeGreaterThan(0)
    expect(reply.result.agentCapabilities.loadSession).toBe(true)
    client.close()
  }, 15000)

  it('answers an initialize sent immediately, even while open() is still resolving', async () => {
    // The production race: the FE sends `initialize` the instant the socket opens,
    // while the server's async open() is still doing the auth + (slow) pipeline
    // lookup. Without buffering that frame is dropped and the handshake hangs.
    const handle = await createTestApp({ database: iso.db, fetchFn: slowHaystackFetch })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    const client = new WebSocket(
      `ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`,
      bearerProtocols(handle.bearerToken),
    )
    // Bind the reply listener up front, then fire initialize the moment the
    // socket opens — before the slow server-side open() can finish.
    const replyPromise = new Promise<string>((resolve, reject) => {
      client.addEventListener('message', (event: MessageEvent) =>
        resolve(typeof event.data === 'string' ? event.data : ''),
      )
      client.addEventListener('close', () => reject(new Error('closed before reply')))
      client.addEventListener('error', () => reject(new Error('errored before reply')))
    })
    client.addEventListener('open', () => {
      client.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' }))
    })

    const reply = JSON.parse(await replyPromise)
    expect(reply.id).toBe(7)
    expect(reply.result.protocolVersion).toBeGreaterThan(0)
    client.close()
  }, 15000)

  it('closes 4001 when the ?pipeline= slug is not a known pipeline', async () => {
    const handle = await createTestApp({ database: iso.db, fetchFn: haystackFetch })
    const port = await startApp(handle.app as unknown as RunningApp)
    cleanups.push(async () => {
      await stopApp(handle.app as unknown as RunningApp)
      await handle.cleanup()
    })

    // `rag` resolves via the fake host; `nope` 404s — the route should reject
    // even with a valid bearer.
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=nope`,
      bearerProtocols(handle.bearerToken),
    )
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })
})
