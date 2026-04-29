/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
