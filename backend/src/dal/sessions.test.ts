import { session, user } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getActiveSessionByToken } from './sessions'

describe('sessions DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const userId = 'test-user-sessions'

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup

    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'Test User',
      email: 'sessions@test.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('returns session for valid non-expired token', async () => {
    const now = new Date()
    const future = new Date(now.getTime() + 3600_000)
    await db.insert(session).values({
      id: 's1',
      expiresAt: future,
      token: 'valid-token',
      createdAt: now,
      updatedAt: now,
      userId,
    })
    const result = await getActiveSessionByToken(db, 'valid-token')
    expect(result).toEqual({ userId })
  })

  it('returns null for expired token', async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 3600_000)
    await db.insert(session).values({
      id: 's2',
      expiresAt: past,
      token: 'expired-token',
      createdAt: now,
      updatedAt: now,
      userId,
    })
    const result = await getActiveSessionByToken(db, 'expired-token')
    expect(result).toBeNull()
  })

  it('returns null for nonexistent token', async () => {
    const result = await getActiveSessionByToken(db, 'no-such-token')
    expect(result).toBeNull()
  })
})
