import { otpExpiryMs } from '@/auth/otp-constants'
import { createOtpChallenge } from '@/dal'
import type { db as DbType } from '@/db/client'

/** Create a challenge token in the DB for auth.api signInEmailOTP calls in tests. */
export const createTestChallenge = async (db: typeof DbType, email: string) => {
  const token = crypto.randomUUID()
  await createOtpChallenge(db, {
    id: crypto.randomUUID(),
    email,
    challengeToken: token,
    expiresAt: new Date(Date.now() + otpExpiryMs),
  })
  return token
}
