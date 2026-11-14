/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineRequestState, hasRequestState } from '@better-auth/core/context'

/** Better Auth path of an email-code sign-in. */
export const otpSignInPath = '/sign-in/email-otp'

/** Better Auth paths that finish an SSO sign-in, including the shared OIDC callback used with `redirectURI`. */
export const ssoSignInPaths: readonly string[] = [
  '/sso/callback/:providerId',
  '/sso/callback',
  '/sso/saml2/sp/acs/:providerId',
]

export type SignInUser = { id: string; email: string; emailVerified: boolean }

export type SignIn = {
  user: SignInUser
  path: string | undefined
  /** The SSO provider said, on this sign-in, that the address is not verified. */
  idpDeniedEmailVerified: boolean
}

const idpDeniedEmailVerifiedState = defineRequestState(() => false)

/**
 * Record, from the SSO `resolveUser` hook, that the provider denied the address is verified. The
 * user row can't carry it: SSO-created users are stored unverified whatever the provider says.
 */
export const recordIdpDeniedEmailVerified = () => idpDeniedEmailVerifiedState.set(true)

/** Whether `recordIdpDeniedEmailVerified` ran during the current request. */
export const didIdpDenyEmailVerified = async () =>
  (await hasRequestState()) && (await idpDeniedEmailVerifiedState.get())
