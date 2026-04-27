/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { otpChallenge, verification } from '@/db/schema'
import { and, eq, gt, lt } from 'drizzle-orm'

/**
 * Get or create a challenge token for an email (first-writer-wins).
 * If a valid (non-expired) challenge already exists, returns the existing token.
 * Only replaces the token when the existing one has expired.
 *
 * Uses Postgres row-level locking via ON CONFLICT ... WHERE to serialize
 * concurrent requests, preventing a race where two instances overwrite
 * each other's tokens.
 */
export const getOrCreateOtpChallenge = async (
  database: typeof DbType,
  data: { id: string; email: string; challengeToken: string; expiresAt: Date },
): Promise<string> => {
  await database
    .insert(otpChallenge)
    .values(data)
    .onConflictDoUpdate({
      target: otpChallenge.email,
      set: { id: data.id, challengeToken: data.challengeToken, expiresAt: data.expiresAt },
      where: lt(otpChallenge.expiresAt, new Date()),
    })

  // Read back the canonical token (ours if we won, existing if still valid)
  const rows = await database
    .select({ challengeToken: otpChallenge.challengeToken })
    .from(otpChallenge)
    .where(eq(otpChallenge.email, data.email))
    .limit(1)

  return rows[0]?.challengeToken ?? data.challengeToken
}

/** Validate a challenge token for an email. Returns true if valid, false otherwise. */
export const validateOtpChallenge = async (database: typeof DbType, email: string, challengeToken: string) => {
  const rows = await database
    .select({ id: otpChallenge.id })
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        eq(otpChallenge.challengeToken, challengeToken),
        gt(otpChallenge.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** Delete all challenge tokens for an email (cleanup after successful verification). */
export const deleteOtpChallengesForEmail = async (database: typeof DbType, email: string) =>
  database.delete(otpChallenge).where(eq(otpChallenge.email, email))

/**
 * Delete the OTP that Better Auth persisted in the verification table.
 * Better Auth's toOTPIdentifier returns `${type}-otp-${email}` (confirmed in email-otp/utils.mjs).
 */
export const deletePersistedSignInOtp = async (database: typeof DbType, email: string) =>
  database.delete(verification).where(eq(verification.identifier, `sign-in-otp-${email}`))
