/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AppLocale } from '@shared/i18n/locales'
import { createAuth } from '@/auth/auth'
import { clearSettingsCache } from '@/config/settings'
import { waitlist } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'

/**
 * `X-App-Language` → email locale across Better Auth's own OTP endpoint
 * (THU-824). This is the highest-volume path — what the browser hits on
 * sign-in — and it reaches the locale through the endpoint context rather than
 * the explicit forward that `/v1/waitlist/join` does, so it needs its own
 * coverage. Dependency injection throughout; no `mock.module`.
 */
describe('email locale from X-App-Language', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const sendSignInEmail = mock((_p: { email: string; locale: AppLocale }) => Promise.resolve())
  const sendWaitlistJoinedEmail = mock((_p: { email: string; locale: AppLocale }) => Promise.resolve())
  const sendWaitlistNotReadyEmail = mock((_p: { email: string; locale: AppLocale }) => Promise.resolve())

  const sendOtp = async (email: string, language?: string): Promise<void> => {
    const auth = createAuth(db, { sendSignInEmail, sendWaitlistJoinedEmail, sendWaitlistNotReadyEmail })
    await auth.api.sendVerificationOTP({
      body: { email, type: 'sign-in' },
      ...(language ? { headers: new Headers({ 'X-App-Language': language }) } : {}),
    })
  }

  beforeEach(async () => {
    process.env.WAITLIST_AUTO_APPROVE_DOMAINS = 'auto-approved.test'
    clearSettingsCache()
    sendSignInEmail.mockClear()
    sendWaitlistJoinedEmail.mockClear()
    sendWaitlistNotReadyEmail.mockClear()
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    delete process.env.WAITLIST_AUTO_APPROVE_DOMAINS
    clearSettingsCache()
    await cleanup()
  })

  it('sends the sign-in email in the requested language', async () => {
    await sendOtp('signin@auto-approved.test', 'ja')

    expect(sendSignInEmail).toHaveBeenCalledWith(expect.objectContaining({ locale: 'ja' }))
  })

  it('sends the waitlist-joined email in the requested language', async () => {
    await sendOtp('newcomer@example.com', 'de')

    expect(sendWaitlistJoinedEmail).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }))
  })

  it('sends the not-ready email in the requested language', async () => {
    await db.insert(waitlist).values({ id: crypto.randomUUID(), email: 'pending@example.com', status: 'pending' })

    await sendOtp('pending@example.com', 'fr')

    expect(sendWaitlistNotReadyEmail).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
  })

  it('falls back to English when the caller sends no language header', async () => {
    await sendOtp('nolang@auto-approved.test')

    expect(sendSignInEmail).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  })

  it('refuses a pseudo-locale arriving over the wire', async () => {
    await sendOtp('pseudo@auto-approved.test', 'en-XA')

    expect(sendSignInEmail).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  })
})
