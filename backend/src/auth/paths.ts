/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Where Better Auth is mounted. */
export const authBasePath = '/v1/api/auth'

/** The provider `buildSsoPlugins` builds from env: the only one SSO sign-in may use. */
export const configuredSsoProviderId = 'sso'

/** Anonymous sign-in, relative to `authBasePath` (the form Better Auth hooks see). */
export const anonymousSignInPath = '/sign-in/anonymous'

/** Session lookup, relative to `authBasePath`. The app calls it on every boot, reconnect and cross-tab session change. */
export const getSessionPath = '/get-session'

/** The passkey calls that verify a relayed WebAuthn challenge. */
export const passkeyVerifyPaths = ['/passkey/verify-registration', '/passkey/verify-authentication']
