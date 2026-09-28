/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'

/** Better Auth includes `isNew` on the signed-in user at runtime but not in its types. */
export const isNewAuthUser = (user: unknown): boolean =>
  typeof user === 'object' && user !== null && 'isNew' in user && (user as { isNew: unknown }).isNew === true

/**
 * After a sign-in, record that an account which already existed has already
 * been onboarded.
 *
 * Sync is off by default, so a device signing in to an established account
 * cannot read the account's real onboarding state — all it has is the `false`
 * that reconcile seeded locally at boot. "The account already existed" is the
 * only signal available at that moment, so we treat it as "onboarding already
 * happened somewhere".
 *
 * **Call this from every sign-in entry point.** Reaching only some of them is
 * GH #1299: the magic-link and SSO paths were missed, so signing in there left
 * the seeded `false` in place and the user redid onboarding.
 *
 * `isNew` must come from the sign-in **response**. The backend retires the flag
 * inside the sign-in request itself, so every later `/get-session` reports
 * `false` — and Better Auth's `useSession()` is only ever fed by
 * `/get-session`. A session-watching reader therefore cannot tell a fresh
 * signup from a returning sign-in; only the response can.
 *
 * Anonymous promotion is deliberately included. The promotion runs through the
 * same OTP endpoint, and the response describes the *real* account, so an
 * anonymous session promoted into an existing account is correctly treated as
 * returning.
 */
export const markOnboardedForReturningUser = async (
  user: unknown,
  // Resolved through the singleton rather than taken from React context: two
  // of the three call sites are hooks whose tests render without a provider,
  // and the lookup belongs inside the catch below anyway.
  getDatabase: () => AnyDrizzleDatabase = getDb,
): Promise<void> => {
  if (isNewAuthUser(user)) {
    return
  }

  // Error containment: a failure in post-auth housekeeping must not propagate
  // to the caller's sign-in handler, which turns any throw into a "verification
  // failed" UI even though the OTP was already consumed and the user is signed
  // in. Log and swallow.
  try {
    await updateSettings(getDatabase(), { user_has_completed_onboarding: true })
  } catch (error) {
    console.error('Failed to mark onboarding complete after sign-in:', error)
  }
}
