/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for POST /v1/ws-ticket.
 *
 * The route lives on the main app, so we drive it through `createTestApp`'s
 * bearer-token-authenticated handle. The ticket store used by both the route
 * and the haystack consumer is the production singleton; we verify the
 * ticket lifecycle end-to-end by minting one here and consuming it directly
 * against the store the route used.
 */

import { authHeaders, createTestApp } from '@/test-utils/e2e'
import { createApp } from '@/index'
import { user as userTable, session as sessionTable } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import { getWsTicketStore, resetWsTicketStoreSingleton } from './ws-ticket-store'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'

const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

describe('POST /v1/ws-ticket', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    resetWsTicketStoreSingleton()
  })

  it('returns 401 with no auth credentials', async () => {
    const handle = await createTestApp()
    cleanups.push(handle.cleanup)

    const res = await handle.app.handle(
      new Request('http://localhost/v1/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'haystack' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for an anonymous user', async () => {
    const { db, cleanup } = await createTestDb()
    cleanups.push(cleanup)
    const app = await createApp({ database: db })

    const userId = `anon-${crypto.randomUUID()}`
    const sessionToken = `anon-session-${crypto.randomUUID()}`
    const now = new Date()
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
      id: `anon-session-row-${userId}`,
      token: sessionToken,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      userId,
      createdAt: now,
      updatedAt: now,
    })

    const bearer = signToken(sessionToken)
    const res = await (app as unknown as { handle: (r: Request) => Promise<Response> }).handle(
      new Request('http://localhost/v1/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ scope: 'haystack' }),
      }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe('ANONYMOUS_TICKET_FORBIDDEN')
  })

  it('returns 200 with a ticket for an authenticated user, and the ticket is consumable exactly once', async () => {
    const handle = await createTestApp()
    cleanups.push(handle.cleanup)

    const res = await handle.app.handle(
      new Request('http://localhost/v1/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(handle.bearerToken) },
        body: JSON.stringify({ scope: 'haystack' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ticket: string; expiresAt: number }
    expect(typeof body.ticket).toBe('string')
    expect(body.ticket.length).toBeGreaterThan(20)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // The route uses the production singleton; consume the same ticket here.
    const store = getWsTicketStore()
    const consumed = store.consumeTicket(body.ticket, 'haystack')
    expect(consumed).not.toBeNull()
    expect(store.consumeTicket(body.ticket, 'haystack')).toBeNull()
  })

  it('returns 400/422 for an invalid scope', async () => {
    const handle = await createTestApp()
    cleanups.push(handle.cleanup)

    const res = await handle.app.handle(
      new Request('http://localhost/v1/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(handle.bearerToken) },
        body: JSON.stringify({ scope: 'nonexistent' }),
      }),
    )
    // Elysia's body-validation error surfaces as 422 by default; older versions
    // surfaced 400. Accept either — both mean "body rejected".
    expect([400, 422]).toContain(res.status)
  })
})
