/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { authRequestHeaders } from '@/contexts/auth-context'
import { challengeTokenHeader } from '@/lib/constants'
import { markOnboardedForReturningUser } from '@/lib/returning-user-onboarding'

type SignInWithOtpArgs = {
  email: string
  otp: string
  /**
   * Omit (or pass `undefined`) to send no challenge-token header at all. An
   * empty string still sends the header.
   */
  challengeToken?: string
  signal?: AbortSignal
  /** The credentials were accepted; cancellation can no longer undo this sign-in. */
  onAuthenticated?: () => void
}

/**
 * The single way to complete an email-OTP sign-in.
 *
 * Every sign-in path goes through here so the post-sign-in work cannot be
 * forgotten. That is not hypothetical: GH #1299 was a path — the emailed magic
 * link — that called `authClient.signIn.emailOtp` directly and skipped marking
 * a returning account as onboarded, so the user redid onboarding there and then
 * uploaded that `false` over the real value on every other device.
 *
 * `isNew` has to be read from the sign-in *response*, which is why this work
 * belongs attached to the call rather than to the session: the backend retires
 * the flag inside this same request, and Better Auth's session atom is fed
 * solely by `/get-session`, so every later read reports `false`.
 *
 * The result is returned untouched so callers keep their own error handling.
 */
export const signInWithOtp = async (
  authClient: AuthClient,
  { email, otp, challengeToken, signal, onAuthenticated }: SignInWithOtpArgs,
): Promise<Awaited<ReturnType<AuthClient['signIn']['emailOtp']>>> => {
  signal?.throwIfAborted()
  const result = await authClient.signIn.emailOtp({
    email,
    otp,
    fetchOptions: {
      signal,
      ...(challengeToken === undefined
        ? {}
        : { headers: authRequestHeaders({ [challengeTokenHeader]: challengeToken }) }),
      // Better Auth invokes the per-call callback before notifying session
      // listeners; its client-wide hook separately guards token persistence.
      onSuccess: () => signal?.throwIfAborted(),
    },
  })

  if (!result.error) {
    onAuthenticated?.()
    // Success has already committed through the auth hooks. Finish housekeeping
    // even when that successful sign-in removes this form from the page.
    await markOnboardedForReturningUser(result.data?.user)
  }

  return result
}
