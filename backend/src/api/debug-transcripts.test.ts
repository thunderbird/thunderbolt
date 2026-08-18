/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session, user } from '@/db/auth-schema'
import { debugTranscriptsTable } from '@/db/debug-transcript-schema'
import { rateLimits } from '@/db/rate-limit-schema'
import type { db as DbType } from '@/db/client'
import { createDebugTranscriptRateLimit } from '@/middleware/rate-limit'
import { createTestDb, getSharedIsolatedTestDb } from '@/test-utils/db'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createDebugTranscriptsRoutes } from './debug-transcripts'

const validBody = {
  threadId: 'thread-123',
  schemaVersion: 1,
  payload: {
    events: [{ type: 'assistant', message: 'Investigating the issue' }],
    metadata: { source: 'desktop' },
  },
  userNote: 'The failure happened after reconnecting.',
  clientVersion: '0.1.123',
}

const betterAuthSecret = 'better-auth-secret-12345678901234567890'

/** Sign a Better Auth bearer token for route tests. */
const signToken = (token: string): string => {
  const signature = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${signature}`
}

describe('Debug Transcripts API', () => {
  let app: ReturnType<typeof createDebugTranscriptsRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnvironment = await createTestDb()
    db = testEnvironment.db
    cleanup = testEnvironment.cleanup
    app = createDebugTranscriptsRoutes({
      auth: mockAuth,
      database: db,
      settings: createTestSettings({ debugTranscriptsEnabled: true }),
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  /** Create the user returned by the authenticated test context. */
  const createAuthenticatedUser = async () => {
    const userId = 'test-user'
    const now = new Date()

    await db.insert(user).values({
      id: userId,
      name: 'Debug Transcript User',
      email: 'debug-transcript@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    return userId
  }

  /** Submit a JSON request to the transcript endpoint. */
  const submitTranscript = (body: string, options: { contentLength?: number; authorization?: string } = {}) => {
    const headers = new Headers({
      'Content-Type': 'application/json',
    })
    if (options.contentLength !== undefined) {
      headers.set('Content-Length', String(options.contentLength))
    }
    if (options.authorization) {
      headers.set('Authorization', options.authorization)
    }

    return app.handle(
      new Request('http://localhost/debug-transcripts', {
        method: 'POST',
        headers,
        body,
      }),
    )
  }

  it('returns a coded 403 before parsing when debug transcripts are disabled', async () => {
    await createAuthenticatedUser()
    app = createDebugTranscriptsRoutes({
      auth: mockAuth,
      database: db,
      settings: createTestSettings({ debugTranscriptsEnabled: false }),
    })

    const response = await submitTranscript('{invalid-json')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Debug transcript uploads are disabled',
      code: 'DEBUG_TRANSCRIPTS_DISABLED',
    })
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('does not apply the disabled flag gate to unrelated routes', async () => {
    const hostApp = new Elysia()
      .get('/health', () => ({ ok: true }))
      .use(
        createDebugTranscriptsRoutes({
          auth: mockAuth,
          database: db,
          settings: createTestSettings({ debugTranscriptsEnabled: false }),
        }),
      )

    const response = await hostApp.handle(new Request('http://localhost/health'))

    expect(response.status).toBe(200)
  })

  it('returns 401 when unauthenticated', async () => {
    app = createDebugTranscriptsRoutes({
      auth: mockAuthUnauthenticated,
      database: db,
      settings: createTestSettings({ debugTranscriptsEnabled: true }),
    })

    const response = await submitTranscript(JSON.stringify(validBody))

    expect(response.status).toBe(401)
  })

  it('rejects unexpected top-level fields', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, userId: 'spoofed-user' }))

    expect(response.status).toBe(422)
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('stores a valid transcript for the authenticated user', async () => {
    const userId = await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify(validBody))

    expect(response.status).toBe(201)
    const responseBody: { id: string } = await response.json()
    const rows = await db.select().from(debugTranscriptsTable).where(eq(debugTranscriptsTable.id, responseBody.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: responseBody.id,
      userId,
      threadId: validBody.threadId,
      schemaVersion: validBody.schemaVersion,
      payload: validBody.payload,
      userNote: validBody.userNote,
      clientVersion: validBody.clientVersion,
    })
  })

  it('rejects payloads larger than two megabytes', async () => {
    await createAuthenticatedUser()
    const oversizedBody = {
      ...validBody,
      payload: { log: 'x'.repeat(2 * 1024 * 1024) },
    }

    const response = await submitTranscript(JSON.stringify(oversizedBody))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'Debug transcript payload exceeds 2 MB',
      code: 'DEBUG_TRANSCRIPT_TOO_LARGE',
    })
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('rejects oversized requests from Content-Length before parsing', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript('{invalid-json', { contentLength: 3 * 1024 * 1024 })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'Debug transcript request exceeds maximum size',
      code: 'DEBUG_TRANSCRIPT_TOO_LARGE',
    })
  })

  it('rejects an empty thread id', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, threadId: '' }))

    expect(response.status).toBe(422)
  })

  it('rejects a whitespace-only thread id', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, threadId: '   ' }))

    expect(response.status).toBe(422)
  })

  it('rejects thread ids longer than 100 characters', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, threadId: 'x'.repeat(101) }))

    expect(response.status).toBe(422)
  })

  it.each([
    ['missing', undefined],
    ['an array', []],
    ['a string', 'nope'],
  ])('rejects %s payload', async (_description, payload) => {
    await createAuthenticatedUser()
    const body = { ...validBody, payload }
    if (payload === undefined) {
      delete body.payload
    }

    const response = await submitTranscript(JSON.stringify(body))

    expect(response.status).toBe(422)
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('rejects schema versions above 1000', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, schemaVersion: 1001 }))

    expect(response.status).toBe(422)
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('rejects notes longer than 2000 characters', async () => {
    await createAuthenticatedUser()

    const response = await submitTranscript(JSON.stringify({ ...validBody, userNote: 'x'.repeat(2001) }))

    expect(response.status).toBe(422)
  })

  it('rejects anonymous users', async () => {
    const userId = 'anonymous-transcript-user'
    const token = 'anonymous-transcript-token'
    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'Anonymous Transcript User',
      email: 'anonymous-transcript@example.com',
      emailVerified: false,
      isAnonymous: true,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(session).values({
      id: 'anonymous-transcript-session',
      token,
      userId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    })
    app = createDebugTranscriptsRoutes({
      auth: createAuth(db),
      database: db,
      settings: createTestSettings({ debugTranscriptsEnabled: true }),
    })

    const response = await submitTranscript(JSON.stringify(validBody), {
      authorization: `Bearer ${signToken(token)}`,
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Forbidden',
      code: 'ANONYMOUS_TRANSCRIPT_FORBIDDEN',
    })
    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })

  it('cascade deletes transcripts when their user is deleted', async () => {
    const userId = await createAuthenticatedUser()
    const response = await submitTranscript(JSON.stringify(validBody))
    expect(response.status).toBe(201)

    await db.delete(user).where(eq(user.id, userId))

    expect(await db.select().from(debugTranscriptsTable)).toHaveLength(0)
  })
})

describe('Debug Transcripts API rate limiting', () => {
  let database: typeof DbType
  let app: ReturnType<typeof createDebugTranscriptsRoutes>

  beforeAll(async () => {
    const isolatedDb = await getSharedIsolatedTestDb()
    database = isolatedDb.db
  })

  beforeEach(async () => {
    await database.delete(rateLimits).where(eq(rateLimits.key, 'debug-transcript:user:test-user'))
    await database.delete(user).where(eq(user.id, 'test-user'))
    const now = new Date()
    await database.insert(user).values({
      id: 'test-user',
      name: 'Rate Limited Transcript User',
      email: 'rate-limited-transcript@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    app = createDebugTranscriptsRoutes({
      auth: mockAuth,
      database,
      settings: createTestSettings({ debugTranscriptsEnabled: true }),
      rateLimit: createDebugTranscriptRateLimit(database, { enabled: true }),
    })
  })

  afterEach(async () => {
    await database.delete(user).where(eq(user.id, 'test-user'))
    await database.delete(rateLimits).where(eq(rateLimits.key, 'debug-transcript:user:test-user'))
  })

  it('persists ten requests and rate limits the eleventh', async () => {
    for (let requestNumber = 0; requestNumber < 10; requestNumber++) {
      const response = await app.handle(
        new Request('http://localhost/debug-transcripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, threadId: `thread-${requestNumber}` }),
        }),
      )
      expect(response.status).toBe(201)
    }

    const response = await app.handle(
      new Request('http://localhost/debug-transcripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      }),
    )

    expect(response.status).toBe(429)
    expect(await database.select().from(debugTranscriptsTable)).toHaveLength(10)
  })
})
