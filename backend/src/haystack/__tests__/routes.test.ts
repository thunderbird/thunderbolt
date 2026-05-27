/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Auth-gate tests for the Haystack WebSocket endpoint. The route only matters
 * once a real ws upgrade lands, so the suite spins up Elysia on an ephemeral
 * port and connects with Bun's WebSocket.
 *
 * Auth contract:
 *  - No ticket in `Sec-WebSocket-Protocol` → close 4001.
 *  - Unknown / already-consumed / wrong-scope ticket → close 4001.
 *  - Valid ticket → ws opens, initialize succeeds, ticket consumed exactly once.
 *
 * The session-cookie fallback that used to live in `beforeHandle` was removed:
 * the production WS client always opens with `credentials: 'omit'`, so the
 * cookie path was dead code. Auth runs in `open()` (not `beforeHandle`) so
 * the single-use ticket isn't burned twice by Bun's adapter calling
 * `beforeHandle` more than once per upgrade.
 */

import { session as sessionTable } from '@/db/auth-schema'
import { createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { getWsTicketStore, resetWsTicketStoreSingleton } from '@/auth/ws-ticket-store'
import { clearSettingsCache } from '@/config/settings'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

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
  // Real settings come from `getSettings()` which reads `process.env`. Inject a
  // valid pipelines config so the route's slug→descriptor lookup resolves;
  // otherwise even authenticated upgrades would close 4001 with "unknown
  // pipeline" before initialize can run.
  const originalPipelinesEnv = process.env.HAYSTACK_PIPELINES
  const originalBaseUrlEnv = process.env.HAYSTACK_BASE_URL
  const originalWorkspaceEnv = process.env.HAYSTACK_WORKSPACE

  beforeEach(() => {
    process.env.HAYSTACK_BASE_URL = 'https://haystack.test'
    process.env.HAYSTACK_WORKSPACE = 'ws-test'
    process.env.HAYSTACK_PIPELINES = JSON.stringify([
      { id: 'rag', name: 'RAG', pipelineName: 'rag-pipeline', pipelineId: 'pipe-uuid' },
    ])
    clearSettingsCache()
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    resetWsTicketStoreSingleton()
    if (originalPipelinesEnv === undefined) {
      delete process.env.HAYSTACK_PIPELINES
    } else {
      process.env.HAYSTACK_PIPELINES = originalPipelinesEnv
    }
    if (originalBaseUrlEnv === undefined) {
      delete process.env.HAYSTACK_BASE_URL
    } else {
      process.env.HAYSTACK_BASE_URL = originalBaseUrlEnv
    }
    if (originalWorkspaceEnv === undefined) {
      delete process.env.HAYSTACK_WORKSPACE
    } else {
      process.env.HAYSTACK_WORKSPACE = originalWorkspaceEnv
    }
    clearSettingsCache()
  })

  it('closes 4001 when no subprotocol (and therefore no ticket) is offered', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`)
    const term = await observeWsTermination(client)
    // Bun's native ws may surface either the application close (4001) or a
    // pre-upgrade abnormal (1006) depending on how the upgrade resolves.
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when only the carrier subprotocol is offered (no ticket entry)', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    // The server echoes `thunderbolt.v1`, so the upgrade succeeds; auth in
    // `open()` then rejects because no ticket subprotocol entry was offered.
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, ['thunderbolt.v1'])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('opens the socket and answers initialize when a valid ticket is offered', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    // Resolve the user behind the test bearer to mint a real ticket for them.
    const sessionToken = handle.bearerToken.split('.')[0]
    const [sessionRow] = await handle.db
      .select({ userId: sessionTable.userId })
      .from(sessionTable)
      .where(eq(sessionTable.token, sessionToken))
      .limit(1)
    expect(sessionRow).toBeDefined()

    const ticket = getWsTicketStore().issueTicket(sessionRow.userId, 'haystack', 30_000)

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, [
      'thunderbolt.v1',
      `thunderbolt.ticket.${ticket}`,
    ])
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('close', () => reject(new Error('closed before open')))
      client.addEventListener('error', () => reject(new Error('errored before open')))
    })

    // Browser sees only the carrier subprotocol — never the auth-bearing one.
    expect(client.protocol).toBe('thunderbolt.v1')

    client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
    const raw = await nextMessage(client)
    const reply = JSON.parse(raw)
    expect(reply.jsonrpc).toBe('2.0')
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBeGreaterThan(0)
    expect(reply.result.agentCapabilities.loadSession).toBe(false)
    client.close()
  })

  it('consumes the ticket exactly once per upgrade (no double-burn)', async () => {
    // Regression guard: in earlier versions auth ran in `beforeHandle`, which
    // Bun's adapter can invoke more than once per upgrade. That burned the
    // single-use ticket on the first call and then closed 4001 on the second.
    // Now that the consume lives in `open()` — which fires exactly once per
    // accepted socket — the store should shrink by exactly 1 per successful
    // upgrade.
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const sessionToken = handle.bearerToken.split('.')[0]
    const [sessionRow] = await handle.db
      .select({ userId: sessionTable.userId })
      .from(sessionTable)
      .where(eq(sessionTable.token, sessionToken))
      .limit(1)

    const store = getWsTicketStore()
    const ticket = store.issueTicket(sessionRow.userId, 'haystack', 30_000)
    const sizeBeforeUpgrade = store.size()

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, [
      'thunderbolt.v1',
      `thunderbolt.ticket.${ticket}`,
    ])
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('close', () => reject(new Error('closed before open')))
      client.addEventListener('error', () => reject(new Error('errored before open')))
    })

    // Exactly one ticket was burned by this upgrade.
    expect(store.size()).toBe(sizeBeforeUpgrade - 1)
    client.close()
  })

  it('closes 4001 when the ticket subprotocol contains a garbage nonce', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, [
      'thunderbolt.v1',
      'thunderbolt.ticket.nope-not-real',
    ])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when the ?pipeline= slug is not in HAYSTACK_PIPELINES', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const sessionToken = handle.bearerToken.split('.')[0]
    const [sessionRow] = await handle.db
      .select({ userId: sessionTable.userId })
      .from(sessionTable)
      .where(eq(sessionTable.token, sessionToken))
      .limit(1)
    const ticket = getWsTicketStore().issueTicket(sessionRow.userId, 'haystack', 30_000)

    // `rag` is configured in beforeEach; `nope` is not — the route should reject.
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=nope`, [
      'thunderbolt.v1',
      `thunderbolt.ticket.${ticket}`,
    ])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })

  it('closes 4001 when the ticket was minted for a different scope', async () => {
    const handle = await createTestApp()
    const port = await startApp(handle)
    cleanups.push(() => closeApp(handle))

    const sessionToken = handle.bearerToken.split('.')[0]
    const [sessionRow] = await handle.db
      .select({ userId: sessionTable.userId })
      .from(sessionTable)
      .where(eq(sessionTable.token, sessionToken))
      .limit(1)
    // Bypass the route's body validator by hand-minting against the store
    // with a scope value the consumer will reject. Cast `as 'haystack'`
    // is the only way TS lets us pass a literal-typed scope arg today; the
    // store treats the value opaquely so the mismatch path still exercises.
    const wrongScope = 'other' as unknown as 'haystack'
    const ticket = getWsTicketStore().issueTicket(sessionRow.userId, wrongScope, 30_000)

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/haystack/ws?pipeline=rag`, [
      'thunderbolt.v1',
      `thunderbolt.ticket.${ticket}`,
    ])
    const term = await observeWsTermination(client)
    expect([4001, 1006]).toContain(term.code)
  })
})
