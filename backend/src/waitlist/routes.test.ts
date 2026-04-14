import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

describe('Waitlist API', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let savedWaitlistDomains: string | undefined

  beforeEach(async () => {
    savedWaitlistDomains = process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    process.env.WAITLIST_AUTO_APPROVE_DOMAINS = 'mozilla.org,thunderbird.net,mozilla.ai,mozilla.com'
    clearSettingsCache()
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = await createApp({ database: db, otpCooldownMs: 0 })
  })

  afterEach(async () => {
    if (savedWaitlistDomains !== undefined) {
      process.env.WAITLIST_AUTO_APPROVE_DOMAINS = savedWaitlistDomains
    } else {
      delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    }
    clearSettingsCache()
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
      // Privacy: response doesn't reveal approval status
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

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
      // Privacy: response doesn't reveal approval status
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

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
      // Privacy: response doesn't reveal approval status
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

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

    it('should return same success response for approved users (privacy)', async () => {
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
      // Privacy: same response as non-approved users - no way to enumerate approved emails
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()
    })

    it('should return same success response for existing BetterAuth user (privacy)', async () => {
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
      // Privacy: same response as new users - no way to enumerate existing accounts
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify no waitlist entry was created (user is in user table, not waitlist)
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'existing@example.com'))
      expect(entries).toHaveLength(0)
    })

    it('should auto-approve mozilla.org domain', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@mozilla.org' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      // Privacy: same response regardless of auto-approval
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify in database with approved status
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@mozilla.org'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })

    it('should auto-approve thunderbird.net domain', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@thunderbird.net' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify in database with approved status
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@thunderbird.net'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })

    it('should auto-approve with case-insensitive domain matching', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'TEST@MOZILLA.ORG' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify in database with approved status (email normalized to lowercase)
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@mozilla.org'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })

    it('should not auto-approve non-whitelisted domains', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@other-domain.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify in database with pending status
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@other-domain.com'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('pending')
    })

    it('should not auto-approve similar but different domains', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@fake-mozilla.org.evil.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify in database with pending status (not auto-approved)
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'test@fake-mozilla.org.evil.com'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('pending')
    })

    it('should upgrade existing pending user with auto-approved domain', async () => {
      // User joined before auto-approval feature was deployed
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'legacy@mozilla.org',
        status: 'pending',
      })

      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'legacy@mozilla.org' }),
        }),
      )

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.challengeToken).toBeDefined()

      // Verify status was upgraded to approved
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'legacy@mozilla.org'))
      expect(entries).toHaveLength(1)
      expect(entries[0].status).toBe('approved')
    })
  })

  describe('Email failure handling (via dependency injection)', () => {
    it('should return 500 if joined email fails to send', async () => {
      // Create app with failing email service - no module mocking needed
      const failingEmailService = {
        sendJoinedEmail: () => Promise.reject(new Error('Email service error')),
        sendReminderEmail: () => Promise.resolve(),
      }
      const appWithFailingEmail = await createApp({ database: db, waitlistEmailService: failingEmailService })

      const response = await appWithFailingEmail.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'email-fail@example.com' }),
        }),
      )

      expect(response.status).toBe(500)

      // DB entry should still exist (inserted before email send)
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'email-fail@example.com'))
      expect(entries).toHaveLength(1)
    })

    it('should return 500 if reminder email fails to send', async () => {
      // Add existing pending user
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'pending-user@example.com',
        status: 'pending',
      })

      // Create app with failing reminder email
      const failingEmailService = {
        sendJoinedEmail: () => Promise.resolve(),
        sendReminderEmail: () => Promise.reject(new Error('Email service error')),
      }
      const appWithFailingEmail = await createApp({ database: db, waitlistEmailService: failingEmailService })

      const response = await appWithFailingEmail.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'pending-user@example.com' }),
        }),
      )

      expect(response.status).toBe(500)
    })
  })
})
