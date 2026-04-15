import { otpExpiryMs } from '@/auth/otp-constants'
import { getOrCreateOtpChallenge } from '@/dal'
import type { db as DbType } from '@/db/client'

/** Create a challenge token in the DB for auth.api signInEmailOTP calls in tests. */
export const createTestChallenge = async (db: typeof DbType, email: string) =>
  getOrCreateOtpChallenge(db, {
    id: crypto.randomUUID(),
    email,
    challengeToken: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + otpExpiryMs),
  })
