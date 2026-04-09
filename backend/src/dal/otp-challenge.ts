import type { db as DbType } from '@/db/client'
import { otpChallenge } from '@/db/schema'
import { and, eq, gt } from 'drizzle-orm'

/** Create a new challenge token for an email, replacing any existing one. */
export const createOtpChallenge = async (
  database: typeof DbType,
  data: { id: string; email: string; challengeToken: string; expiresAt: Date },
) => {
  await database
    .insert(otpChallenge)
    .values(data)
    .onConflictDoUpdate({
      target: otpChallenge.email,
      set: { challengeToken: data.challengeToken, expiresAt: data.expiresAt },
    })
}

/** Validate a challenge token for an email. Returns true if valid, false otherwise. */
export const validateOtpChallenge = async (database: typeof DbType, email: string, challengeToken: string) =>
  database
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
    .then((rows) => rows.length > 0)

/** Delete all challenge tokens for an email (cleanup after successful verification). */
export const deleteOtpChallengesForEmail = async (database: typeof DbType, email: string) =>
  database.delete(otpChallenge).where(eq(otpChallenge.email, email))
