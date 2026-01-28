import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Waitlist API', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = await createApp({ database: db })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('POST /v1/waitlist/join', () => {
    it('should add email to waitlist with pending status', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({ success: true, approved: false })

      // Verify in database
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@example.com'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('pending')
    })

    it('should normalize email to lowercase', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'TEST@EXAMPLE.COM' }),
        }),
      )

      expect(response.status).toBe(200)

      // Verify email was lowercased in database
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@example.com'))
      expect(entries).toHaveLength(1)
    })

    it('should return success for duplicate email without creating new entry', async () => {
      // First submission
      await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'duplicate@example.com' }),
        }),
      )

      // Second submission with same email
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'duplicate@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({ success: true, approved: false })

      // Verify only one entry exists
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'duplicate@example.com'))
      expect(entries).toHaveLength(1)
    })

    it('should return success for duplicate email with different case', async () => {
      // First submission
      await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'case@example.com' }),
        }),
      )

      // Second submission with different case
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'CASE@EXAMPLE.COM' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({ success: true, approved: false })

      // Verify only one entry exists
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'case@example.com'))
      expect(entries).toHaveLength(1)
    })

    it('should reject invalid email format', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'not-an-email' }),
        }),
      )

      expect(response.status).toBe(422)
    })

    it('should reject missing email', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(response.status).toBe(422)
    })

    it('should return approved: true for approved users', async () => {
      // Add approved user directly to database
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'approved@example.com',
        status: 'approved',
      })

      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'approved@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({ success: true, approved: true })
    })

    it('should return approved: true for existing BetterAuth user', async () => {
      // Add existing user directly to BetterAuth user table
      await db.insert(user).values({
        id: crypto.randomUUID(),
        name: 'Existing User',
        email: 'existing@example.com',
        emailVerified: true,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'existing@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({ success: true, approved: true })

      // Verify no waitlist entry was created
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'existing@example.com'))
      expect(entries).toHaveLength(0)
    })
  })
})
