/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { timingSafeEqual } from 'node:crypto'

import { otpExpiryMs } from '@/auth/otp-constants'
import type { QueryableDatabase, db as DbType } from '@/db/client'
import { verification } from '@/db/auth-schema'
import { desc, eq, sql } from 'drizzle-orm'

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

/**
 * Length-invariant here (codes are fixed-width), so the compare leaks nothing
 * but equality.
 *
 * NO TEST ENFORCES THIS. Swapping the body for `a === b` passes the whole
 * suite — timing is not observable from the test harness, and a wall-clock
 * assertion would be flaky. It is held by review alone, so do not "simplify" it.
 */
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
const writeFreshOtp = async (tx: QueryableDatabase, identifier: string): Promise<string> => {
  const code = generateStepUpOtp()
  await tx.delete(verification).where(eq(verification.identifier, identifier))
  await tx.insert(verification).values({
    id: crypto.randomUUID(),
    identifier,
    value: `${code}:0`,
    expiresAt: new Date(Date.now() + stepUpOtpExpiryMs),
  })
  return code
}

export const mintStepUpOtp = async (database: typeof DbType, email: string): Promise<string> =>
  database.transaction((tx) => writeFreshOtp(tx, stepUpIdentifier(email)))

/**
 * Minimum spacing between two emailed codes for one account. Caps both the
 * volume of mail a still-trusted attacker can aim at the owner and the rate at
 * which codes can be rotated out from under them.
 */
export const stepUpRequestCooldownMs = 30_000

export type StepUpRequest = { status: 'sent'; code: string } | { status: 'cooling-down' }

/**
 * The route's entry point: enforce the cooldown and mint, atomically.
 *
 * The cooldown was an in-process `Map<userId, timestamp>` written AFTER the
 * email send, which failed three ways. It was per-replica, so the real spacing
 * was 30s ÷ instances. It was check-then-act across a network call, so two
 * concurrent requests both passed — and since every mint deletes the
 * outstanding row, the user got two emails of which the first was already dead,
 * and spending attempts on it charged them against the second. And it never
 * evicted.
 *
 * The outstanding row's own `createdAt` answers all three: it is shared by
 * every replica, and it expires on its own. The advisory lock is what makes it
 * atomic — `FOR UPDATE` would not, because the first request for an account
 * has no row to lock.
 *
 * Note the ordering consequence: the cooldown now starts at the MINT, not at a
 * successful send, so if the mail provider fails the caller waits it out rather
 * than retrying immediately. That is the correct direction — the previous code
 * left a live code behind with no cooldown recorded at all.
 */
export const requestStepUpOtp = async (database: typeof DbType, email: string): Promise<StepUpRequest> => {
  const identifier = stepUpIdentifier(email)
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${identifier})::bigint)`)
    const [outstanding] = await tx
      .select({ createdAt: verification.createdAt })
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .orderBy(desc(verification.createdAt))
      .limit(1)
    if (outstanding && Date.now() - outstanding.createdAt.getTime() < stepUpRequestCooldownMs) {
      return { status: 'cooling-down' as const }
    }
    return { status: 'sent' as const, code: await writeFreshOtp(tx, identifier) }
  })
}

/**
 * Why a union rather than a boolean: every outcome below is a *rejection the
 * caller chose*, so a storage failure stays an exception and surfaces as a 500
 * instead of telling a user their code was wrong during an outage — the
 * distinction c1af9178b drew when this still went through better-auth, which
 * signalled all four by throwing.
 */
export type StepUpOtpVerdict = 'valid' | 'invalid' | 'expired' | 'too-many-attempts'

/**
 * Check a submitted code, charging the attempt budget for a wrong one. Does not
 * consume a valid code.
 *
 * The read and the charge share one transaction and the row is taken `FOR
 * UPDATE`, so concurrent guesses queue instead of interleaving. Without that
 * they each read the same `attempts` and each write the same `attempts + 1`, so
 * a batch of N wrong guesses costs ONE attempt and the budget stops bounding
 * anything. A conditional write is not enough — it only turns the loser's write
 * into a no-op, which lands on the same undercount. The caller holds a session,
 * which is precisely the attacker this gate exists to stop, so issuing the
 * guesses in parallel costs it nothing.
 */
export const verifyStepUpOtp = async (database: typeof DbType, email: string, otp: string): Promise<StepUpOtpVerdict> =>
  database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(verification)
      .where(eq(verification.identifier, stepUpIdentifier(email)))
      .orderBy(desc(verification.createdAt))
      .limit(1)
      .for('update')
    if (!row) {
      return 'invalid'
    }
    if (row.expiresAt < new Date()) {
      await tx.delete(verification).where(eq(verification.id, row.id))
      return 'expired'
    }
    const { code, attempts } = splitStoredOtp(row.value)
    if (attempts >= stepUpAllowedAttempts) {
      await tx.delete(verification).where(eq(verification.id, row.id))
      return 'too-many-attempts'
    }
    if (!constantTimeEquals(code, otp)) {
      await tx
        .update(verification)
        .set({ value: `${code}:${attempts + 1}` })
        .where(eq(verification.id, row.id))
      return 'invalid'
    }
    return 'valid'
  })

/**
 * Single-use enforcement: `verifyStepUpOtp` deliberately does NOT consume a
 * valid code, so the rotate route deletes the row after its transaction
 * commits. Delete-on-commit (not on-check) keeps a rotation that fails midway
 * retryable with the same code.
 */
export const consumeStepUpOtp = (database: typeof DbType, email: string) =>
  database.delete(verification).where(eq(verification.identifier, stepUpIdentifier(email)))
