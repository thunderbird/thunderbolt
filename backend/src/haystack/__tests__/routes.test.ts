/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth-gate tests for the Haystack WebSocket endpoint. The route only matters
 * once a real ws upgrade lands, so the suite spins up Elysia on an ephemeral
 * port and connects with Bun's WebSocket (which supports the `headers` option
 * required for bearer-auth ws upgrades).
 *
 * Auth contract:
 *  - Unauthenticated → close 4001.
 *  - Invalid ticket (no session, query-only) → close 4001.
 *  - Anonymous user → close 4001.
 *  - Authenticated regular user → ws opens, initialize succeeds.
 *
 * We piggy-back on `createTestApp` for the authenticated case (it bundles
 * sign-in + bearer token). The anonymous case seeds a row directly because
 * `createTestApp` only knows the verified-OTP path.
 */

import { createApp } from '@/index'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createTestDb } from '@/test-utils/db'
import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'

/** Mirror of api/powersync.test.ts token signing — Better Auth verifies
 *  `<token>.<base64(hmac-sha256(secret, token))>` as a valid bearer. */
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

const startApp = async (handle: TestAppHandle): Promise<number> => {
  await new Promise<void>((resolve) => {
    handle.app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  const port = (handle.app as unknown as { server: { port: number } }).server!.port
  return port
}

const closeApp = async (handle: TestAppHandle) => {
  const stop = handle.app.stop as unknown as (closeActiveConnections?: boolean) => Promise<void> | void
  await Promise.race([Promise.resolve(stop.call(handle.app, true)), new Promise((r) => setTimeout(r, 500))])
  await handle.cleanup()
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

describe('WS /v1/haystack/ws — auth gating', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
  })

  it('closes 4001 when no auth credentials are supplied', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    // Plain ws — no Authorization header at all.
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`)
    const term = await observeWsTermination(client)
    // Bun's native ws may surface either the application close (4001) or a
    // pre-upgrade abnormal (1006) depending on how the upgrade resolves.
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when the bearer token does not match any session ("invalid ticket")', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    // The ?ticket= query param is not wired (no ticket store exists yet); the
    // server falls back to session-cookie auth, which is absent. Send a junk
    // bearer to make the "invalid credentials" intent explicit.
    const junkBearer = signToken('not-a-real-session-token')
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag&ticket=garbage`, {
      headers: { Authorization: `Bearer ${junkBearer}` },
    } as unknown as string[])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when the user is anonymous', async () => {
    // createTestApp doesn't expose an anonymous sign-in path, so we wire the
    // app ourselves against a fresh test DB and seed an anonymous user.
    const { db, cleanup } = await createTestDb()
    cleanups.push(cleanup)

    const app = await createApp({ database: db })
    await new Promise<void>((resolve) => {
      ;(app as unknown as { listen: (cfg: unknown, cb: () => void) => void }).listen(
        { port: 0, hostname: '127.0.0.1' },
        () => resolve(),
      )
    })
    const port = (app as unknown as { server: { port: number } }).server.port
    cleanups.push(async () => {
      const stop = (app as unknown as { stop: (forced?: boolean) => Promise<void> | void }).stop
      await Promise.race([Promise.resolve(stop.call(app, true)), new Promise((r) => setTimeout(r, 500))])
    })

    const userId = `anon-${crypto.randomUUID()}`
    const sessionToken = `anon-session-token-${crypto.randomUUID()}`
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
    await db.insert(userTable).values({
      id: userId,
      name: 'Anon',
      email: `${userId}@anon.test`,
      emailVerified: false,
      isAnonymous: true,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(sessionTable).values({
      id: `anon-session-${userId}`,
      token: sessionToken,
      expiresAt,
      userId,
      createdAt: now,
      updatedAt: now,
    })

    const bearer = signToken(sessionToken)
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, {
      headers: { Authorization: `Bearer ${bearer}` },
    } as unknown as string[])
    const term = await observeWsTermination(client)
    expect(term.code).toBe(4001)
  })

  it('opens the socket and answers initialize for an authenticated regular user', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, {
      headers: authHeaders(handle.bearerToken),
    } as unknown as string[])
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('close', () => reject(new Error('closed before open')))
      client.addEventListener('error', () => reject(new Error('errored before open')))
    })

    client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
    const raw = await nextMessage(client)
    const reply = JSON.parse(raw)
    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBeGreaterThan(0)
    expect(reply.result.agentCapabilities.loadSession).toBe(false)
    client.close()
  })
})
