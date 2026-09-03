/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { otpExpiryMs } from '@/auth/otp-constants'
import type { Auth } from '@/auth/auth'
import {
  approveWaitlistEntry,
  getOrCreateOtpChallenge,
  createWaitlistEntry,
  getUserByEmail,
  getWaitlistByEmail,
} from '@/dal'
import type { db } from '@/db/client'
import { normalizeEmail } from '@/lib/email'
import { resolveEmailLocale } from '@/emails/i18n'
import type { AppLocale } from '@shared/i18n/locales'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'
import {
  isAutoApprovedDomain,
  sendWaitlistJoinedEmail as defaultSendJoinedEmail,
  sendWaitlistReminderEmail as defaultSendReminderEmail,
} from './utils'

/**
 * Email service interface for dependency injection.
 * Allows tests to provide fake implementations without module mocking.
 */
export type WaitlistEmailService = {
  sendJoinedEmail: (params: { email: string; locale: AppLocale }) => Promise<void>
  sendReminderEmail: (params: { email: string; locale: AppLocale }) => Promise<void>
}

const defaultEmailService: WaitlistEmailService = {
  sendJoinedEmail: defaultSendJoinedEmail,
  sendReminderEmail: defaultSendReminderEmail,
}

/**
 * Trigger Better Auth's OTP flow for approved users.
 *
 * Forwards the already-resolved locale as a synthetic header so
 * `sendVerificationOTP` renders in the recipient's language; without it the
 * endpoint context has no headers and the magic-link email falls back to
 * English. Only this one header is passed on: handing an internal `auth.api`
 * call the caller's whole inbound header bag would carry cookies and
 * `authorization` across the boundary, and a stray `x-api-key` alone is enough
 * to trip the api-key plugin's before-hook and fail the send.
 */
const sendApprovedMagicLinkEmail = async (auth: Auth, email: string, locale: AppLocale): Promise<void> => {
  await auth.api.sendVerificationOTP({
    body: { email, type: 'sign-in' },
    headers: new Headers({ 'X-App-Language': locale }),
  })
}

/**
 * Resolve whether an email is approved to receive an OTP.
 * Handles side effects (creating waitlist entries, sending emails) along the way.
 * Returns true for existing users, approved waitlist entries, and auto-approved domains.
 */
const resolveApproval = async (
  database: typeof db,
  email: string,
  locale: AppLocale,
  emailService: WaitlistEmailService,
): Promise<boolean> => {
  const existingUser = await getUserByEmail(database, email)
  if (existingUser) {
    return true
  }

  const existing = await getWaitlistByEmail(database, email)

  if (existing) {
    if (existing.status === 'approved') {
      return true
    }

    if (isAutoApprovedDomain(email)) {
      await approveWaitlistEntry(database, existing.id)
      return true
    }

    await emailService.sendReminderEmail({ email, locale })
    return false
  }

  const autoApproved = isAutoApprovedDomain(email)
  await createWaitlistEntry(database, {
    id: crypto.randomUUID(),
    email,
    status: autoApproved ? 'approved' : 'pending',
  })

  if (autoApproved) {
    return true
  }

  await emailService.sendJoinedEmail({ email, locale })
  return false
}

/** Default cooldown between OTP requests per email (15 seconds). */
const defaultCooldownMs = 15_000

type WaitlistRoutesOptions = {
  database: typeof db
  auth: Auth
  emailService?: WaitlistEmailService
  /** Cooldown between OTP requests per email in ms. Default: 15000. Set to 0 to disable. */
  cooldownMs?: number
  ipRateLimit?: AnyElysia
}

export const createWaitlistRoutes = ({
  database,
  auth,
  emailService = defaultEmailService,
  cooldownMs = defaultCooldownMs,
  ipRateLimit,
}: WaitlistRoutesOptions) => {
  // Per-instance cooldown tracker. Tracks when the last OTP request was made for each email
  // to prevent rapid code cycling. In-memory is appropriate: 15s window, single-instance defense.
  const emailCooldowns = new Map<string, number>()

  const app = new Elysia({ prefix: '/waitlist' }).onError(safeErrorHandler)
  if (ipRateLimit) {
    app.use(ipRateLimit)
  }

  return app.post(
    '/join',
    async ({ body, set, request }) => {
      const email = normalizeEmail(body.email)
      const locale = resolveEmailLocale(request.headers.get('X-App-Language'))

      if (cooldownMs > 0) {
        const now = Date.now()
        const lastRequest = emailCooldowns.get(email)
        if (lastRequest && now - lastRequest < cooldownMs) {
          set.status = 429
          return {
            error: 'code_already_sent',
            message: 'A verification code was recently sent. Please wait before requesting a new one.',
          }
        }
        // Prune expired entries to prevent unbounded growth
        if (emailCooldowns.size > 1000) {
          for (const [key, ts] of emailCooldowns) {
            if (now - ts >= cooldownMs) {
              emailCooldowns.delete(key)
            }
          }
        }
      }

      // Record cooldown immediately (before any async work) to close the race window
      // where concurrent requests could pass the check before the timestamp is written.
      if (cooldownMs > 0) {
        emailCooldowns.set(email, Date.now())
      }

      const approved = await resolveApproval(database, email, locale, emailService)

      if (!approved) {
        return { success: true }
      }

      const challengeToken = await getOrCreateOtpChallenge(database, {
        id: crypto.randomUUID(),
        email,
        challengeToken: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + otpExpiryMs),
      })
      await sendApprovedMagicLinkEmail(auth, email, locale)
      return { success: true, challengeToken }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
      }),
    },
  )
}
