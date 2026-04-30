/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { otpChallenge } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { getOrCreateOtpChallenge, validateOtpChallenge, deleteOtpChallengesForEmail } from './otp-challenge'

describe('getOrCreateOtpChallenge', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const makeChallenge = (email: string, overrides?: { challengeToken?: string; expiresAt?: Date }) => ({
    id: crypto.randomUUID(),
    email,
    challengeToken: overrides?.challengeToken ?? crypto.randomUUID(),
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 600_000),
  })

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should create a new challenge when none exists', async () => {
    const data = makeChallenge('new@example.com', { challengeToken: 'token-a' })
    const result = await getOrCreateOtpChallenge(db, data)

    expect(result).toBe('token-a')

    const rows = await db.select().from(otpChallenge).where(eq(otpChallenge.email, 'new@example.com'))
    expect(rows).toHaveLength(1)
    expect(rows[0].challengeToken).toBe('token-a')
  })

  it('should return existing token when a non-expired challenge exists (first-writer-wins)', async () => {
    const first = makeChallenge('existing@example.com', { challengeToken: 'first-token' })
    await getOrCreateOtpChallenge(db, first)

    const second = makeChallenge('existing@example.com', { challengeToken: 'second-token' })
    const result = await getOrCreateOtpChallenge(db, second)

    expect(result).toBe('first-token')

    const rows = await db.select().from(otpChallenge).where(eq(otpChallenge.email, 'existing@example.com'))
    expect(rows).toHaveLength(1)
    expect(rows[0].challengeToken).toBe('first-token')
  })

  it('should replace an expired challenge with a new token', async () => {
    const expired = makeChallenge('expired@example.com', {
      challengeToken: 'old-token',
      expiresAt: new Date(Date.now() - 1000),
    })
    // Insert the expired challenge directly
    await db.insert(otpChallenge).values(expired)

    const fresh = makeChallenge('expired@example.com', { challengeToken: 'new-token' })
    const result = await getOrCreateOtpChallenge(db, fresh)

    expect(result).toBe('new-token')

    const rows = await db.select().from(otpChallenge).where(eq(otpChallenge.email, 'expired@example.com'))
    expect(rows).toHaveLength(1)
    expect(rows[0].challengeToken).toBe('new-token')
  })

  it('should return the same token for concurrent requests (both get first-writer token)', async () => {
    const email = 'concurrent@example.com'

    const [resultA, resultB] = await Promise.all([
      getOrCreateOtpChallenge(db, makeChallenge(email, { challengeToken: 'token-a' })),
      getOrCreateOtpChallenge(db, makeChallenge(email, { challengeToken: 'token-b' })),
    ])

    // Both should return the same token (whichever won the insert)
    expect(resultA).toBe(resultB)

    const rows = await db.select().from(otpChallenge).where(eq(otpChallenge.email, email))
    expect(rows).toHaveLength(1)
    expect(rows[0].challengeToken).toBe(resultA)
  })

  it('should not affect challenges for different emails', async () => {
    const tokenA = await getOrCreateOtpChallenge(db, makeChallenge('a@example.com', { challengeToken: 'token-a' }))
    const tokenB = await getOrCreateOtpChallenge(db, makeChallenge('b@example.com', { challengeToken: 'token-b' }))

    expect(tokenA).toBe('token-a')
    expect(tokenB).toBe('token-b')

    const rows = await db.select().from(otpChallenge)
    expect(rows).toHaveLength(2)
  })
})

describe('validateOtpChallenge', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should return true for valid non-expired challenge', async () => {
    const token = await getOrCreateOtpChallenge(db, {
      id: crypto.randomUUID(),
      email: 'valid@example.com',
      challengeToken: 'my-token',
      expiresAt: new Date(Date.now() + 600_000),
    })

    const result = await validateOtpChallenge(db, 'valid@example.com', token)
    expect(result).toBe(true)
  })

  it('should return false for wrong token', async () => {
    await getOrCreateOtpChallenge(db, {
      id: crypto.randomUUID(),
      email: 'wrong@example.com',
      challengeToken: 'real-token',
      expiresAt: new Date(Date.now() + 600_000),
    })

    const result = await validateOtpChallenge(db, 'wrong@example.com', 'fake-token')
    expect(result).toBe(false)
  })

  it('should return false for expired challenge', async () => {
    await db.insert(otpChallenge).values({
      id: crypto.randomUUID(),
      email: 'expired@example.com',
      challengeToken: 'expired-token',
      expiresAt: new Date(Date.now() - 1000),
    })

    const result = await validateOtpChallenge(db, 'expired@example.com', 'expired-token')
    expect(result).toBe(false)
  })
})

describe('deleteOtpChallengesForEmail', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should delete all challenges for the given email', async () => {
    await getOrCreateOtpChallenge(db, {
      id: crypto.randomUUID(),
      email: 'delete@example.com',
      challengeToken: 'token',
      expiresAt: new Date(Date.now() + 600_000),
    })

    await deleteOtpChallengesForEmail(db, 'delete@example.com')

    const rows = await db.select().from(otpChallenge).where(eq(otpChallenge.email, 'delete@example.com'))
    expect(rows).toHaveLength(0)
  })

  it('should not affect other emails', async () => {
    await getOrCreateOtpChallenge(db, {
      id: crypto.randomUUID(),
      email: 'keep@example.com',
      challengeToken: 'keep-token',
      expiresAt: new Date(Date.now() + 600_000),
    })
    await getOrCreateOtpChallenge(db, {
      id: crypto.randomUUID(),
      email: 'remove@example.com',
      challengeToken: 'remove-token',
      expiresAt: new Date(Date.now() + 600_000),
    })

    await deleteOtpChallengesForEmail(db, 'remove@example.com')

    const remaining = await db.select().from(otpChallenge)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].email).toBe('keep@example.com')
  })
})
