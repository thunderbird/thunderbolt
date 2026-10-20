/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { createAuth } from '@/auth/auth'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import type { db as DbType } from '@/db/client'
import { waitlist } from '@/db/schema'
import { createTestChallenge } from '@/test-utils/otp-challenge'

/** Sign a fresh waitlist-approved user in through email OTP and return their session cookie. */
export const createSessionCookie = async (auth: ReturnType<typeof createAuth>, db: typeof DbType) => {
  const email = `session-${crypto.randomUUID()}@example.com`
  await db.insert(waitlist).values({ id: crypto.randomUUID(), email, status: 'approved' })

  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  const response = (await auth.api.signInEmailOTP({
    body: { email, otp: testSignInOtp },
    headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
    asResponse: true,
  })) as Response
  if (!response.ok) {
    throw new Error(`Email OTP sign-in failed with ${response.status}`)
  }

  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}
