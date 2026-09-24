/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { timingSafeEqual } from 'node:crypto'

import { otpExpiryMs } from '@/auth/otp-constants'
import type { db as DbType } from '@/db/client'
import { verification } from '@/db/auth-schema'
import { desc, eq } from 'drizzle-orm'

/**
 * Step-up verification codes for a recovery-phrase change (THU-875).
 *
 * The code rides Better Auth's `verification` table but is NOT a Better Auth
 * OTP. It used to be one, stored under the `email-verification` type, and that
 * was the bug: `POST /email-otp/check-verification-otp` is UNAUTHENTICATED and
 * takes only an email, so anyone who knew the address could spend the row's
 * three attempts and keep the owner from ever changing their recovery phrase.
 *
 * The fix is the identifier namespace. Better Auth builds every one of its own
 * identifiers as `toOTPIdentifier(type, email)` = `${type}-otp-${email}`, and
 * `type` is a closed enum — `email-verification | sign-in | forget-password |
 * change-email` — so no Better Auth route can name a row prefixed
 * `e2ee-step-up-`. Its only untargeted touch on the table is the expired-row
 * sweep inside `findVerificationValue`, which deletes strictly on
 * `expiresAt < now` and therefore only collects rows this module would reject
 * anyway.
 *
 * Owning the row means owning the whole policy below: generation, the stored
 * `<code>:<attempts>` format (Better Auth's convention, kept so the e2e helper
 * can still read it), the attempt budget, the timing-safe compare, and expiry.
 */

/** Mirrors the shape of better-auth's identifiers without colliding with any type it can construct. */
export const stepUpIdentifier = (email: string): string => `e2ee-step-up-otp-${email.toLowerCase()}`

/** Digits per code. 10^8 keyspace, matching the sign-in OTP and the frontend's input width. */
export const stepUpOtpLength = 8

/** Same 10-minute window as the sign-in OTP — long enough to switch to an inbox, short enough to matter. */
const stepUpOtpExpiryMs = otpExpiryMs

/** Online-guessing budget for a single code. Exhausting it destroys the row; a new one must be requested. */
const stepUpAllowedAttempts = 3

/**
 * Uniform digits: a byte is rejected rather than folded when it lands in the
 * short tail (250–255), which would otherwise bias 0–5 upward.
 */
const generateStepUpOtp = (): string => {
  const digits: string[] = []
  while (digits.length < stepUpOtpLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(stepUpOtpLength))
    for (const byte of bytes) {
      if (byte >= 250 || digits.length === stepUpOtpLength) {
        continue
      }
      digits.push(String(byte % 10))
    }
  }
  return digits.join('')
}

/** Length-invariant here (codes are fixed-width), so the compare leaks nothing but equality. */
const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Stored as `<code>:<attempts>`; a value without the suffix counts as zero attempts. */
const splitStoredOtp = (value: string): { code: string; attempts: number } => {
  const idx = value.lastIndexOf(':')
  if (idx === -1) {
    return { code: value, attempts: 0 }
  }
  const attempts = Number.parseInt(value.slice(idx + 1), 10)
  return { code: value.slice(0, idx), attempts: Number.isNaN(attempts) ? 0 : attempts }
}

/**
 * Mint a fresh code, replacing any outstanding one.
 *
 * Rotate-per-request, not Better Auth's `resendStrategy: 'reuse'`. Reuse exists
 * to stop an unauthenticated resend from clearing the attempt counter; this row
 * has no unauthenticated door, and every mint is an authenticated request from
 * a trusted device, cooldown-gated, that also emails the account owner. Under
 * those conditions a fresh random code per request is strictly better: a
 * guesser never accumulates attempts against one fixed target.
 */
export const mintStepUpOtp = async (database: typeof DbType, email: string): Promise<string> => {
  const code = generateStepUpOtp()
  const identifier = stepUpIdentifier(email)
  await database.transaction(async (tx) => {
    await tx.delete(verification).where(eq(verification.identifier, identifier))
    await tx.insert(verification).values({
      id: crypto.randomUUID(),
      identifier,
      value: `${code}:0`,
      expiresAt: new Date(Date.now() + stepUpOtpExpiryMs),
    })
  })
  return code
}

/**
 * Why a union rather than a boolean: every outcome below is a *rejection the
 * caller chose*, so a storage failure stays an exception and surfaces as a 500
 * instead of telling a user their code was wrong during an outage — the
 * distinction c1af9178b drew when this still went through better-auth, which
 * signalled all four by throwing.
 */
export type StepUpOtpVerdict = 'valid' | 'invalid' | 'expired' | 'too-many-attempts'

/** Check a submitted code, charging the attempt budget for a wrong one. Does not consume a valid code. */
export const verifyStepUpOtp = async (
  database: typeof DbType,
  email: string,
  otp: string,
): Promise<StepUpOtpVerdict> => {
  const [row] = await database
    .select()
    .from(verification)
    .where(eq(verification.identifier, stepUpIdentifier(email)))
    .orderBy(desc(verification.createdAt))
    .limit(1)
  if (!row) {
    return 'invalid'
  }
  if (row.expiresAt < new Date()) {
    await database.delete(verification).where(eq(verification.id, row.id))
    return 'expired'
  }
  const { code, attempts } = splitStoredOtp(row.value)
  if (attempts >= stepUpAllowedAttempts) {
    await database.delete(verification).where(eq(verification.id, row.id))
    return 'too-many-attempts'
  }
  if (!constantTimeEquals(code, otp)) {
    await database
      .update(verification)
      .set({ value: `${code}:${attempts + 1}` })
      .where(eq(verification.id, row.id))
    return 'invalid'
  }
  return 'valid'
}

/**
 * Single-use enforcement: `verifyStepUpOtp` deliberately does NOT consume a
 * valid code, so the rotate route deletes the row after its transaction
 * commits. Delete-on-commit (not on-check) keeps a rotation that fails midway
 * retryable with the same code.
 */
export const consumeStepUpOtp = (database: typeof DbType, email: string) =>
  database.delete(verification).where(eq(verification.identifier, stepUpIdentifier(email)))
