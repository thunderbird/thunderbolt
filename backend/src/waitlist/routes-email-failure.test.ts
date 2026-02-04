import { mock } from 'bun:test'

// Mock email functions BEFORE importing modules that use them
const mockSendJoinedEmail = mock(() => Promise.reject(new Error('Resend API error')))
const mockSendReminderEmail = mock(() => Promise.reject(new Error('Resend API error')))
const mockSendNotReadyEmail = mock(() => Promise.resolve())

mock.module('@/waitlist/utils', () => ({
  sendWaitlistJoinedEmail: mockSendJoinedEmail,
  sendWaitlistReminderEmail: mockSendReminderEmail,
  sendWaitlistNotReadyEmail: mockSendNotReadyEmail,
}))

// Now import the rest
import { waitlist } from '@/db/schema'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Waitlist API - Email Failure Handling', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    mockSendJoinedEmail.mockClear()
    mockSendReminderEmail.mockClear()

    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = await createApp({ database: db })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('POST /v1/waitlist/join', () => {
    it('should return success even if joined email fails to send', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'email-fail-new@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      // Privacy: response doesn't reveal approval status
      expect(await response.json()).toEqual({ success: true })

      // DB entry should exist despite email failure
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'email-fail-new@example.com'))
      expect(entries).toHaveLength(1)
      expect(mockSendJoinedEmail).toHaveBeenCalledTimes(1)
    })

    it('should return success even if reminder email fails to send', async () => {
      await db.insert(waitlist).values({
        id: crypto.randomUUID(),
        email: 'email-fail-duplicate@example.com',
        status: 'pending',
      })

      // Duplicate submission triggers reminder email
      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'email-fail-duplicate@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      // Privacy: response doesn't reveal approval status
      expect(await response.json()).toEqual({ success: true })

      // No duplicate entry created
      const entries = await db.select().from(waitlist).where(eq(waitlist.email, 'email-fail-duplicate@example.com'))
      expect(entries).toHaveLength(1)
      expect(mockSendReminderEmail).toHaveBeenCalledTimes(1)
    })
  })
})
