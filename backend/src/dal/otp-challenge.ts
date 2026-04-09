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

/** Validate a challenge token for an email. Returns the record if valid, null otherwise. */
export const validateOtpChallenge = async (database: typeof DbType, email: string, challengeToken: string) =>
  database
    .select()
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        eq(otpChallenge.challengeToken, challengeToken),
        gt(otpChallenge.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Get the latest challenge token for an email. */
export const getOtpChallengeByEmail = async (database: typeof DbType, email: string) =>
  database
    .select()
    .from(otpChallenge)
    .where(and(eq(otpChallenge.email, email), gt(otpChallenge.expiresAt, new Date())))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Delete all challenge tokens for an email (cleanup after successful verification). */
export const deleteOtpChallengesForEmail = async (database: typeof DbType, email: string) =>
  database.delete(otpChallenge).where(eq(otpChallenge.email, email))
