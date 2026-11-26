/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

const deactivated = msg`Your account has been deactivated. Ask your administrator to restore your access.`

// A Map, not an object: the code comes from the URL, and `messages['constructor']` would hit Object.prototype.
// Each entry builds its descriptor so copy naming the app can take the deployment's name.
const messages = new Map<string, (appName: string) => MessageDescriptor>([
  ['access_denied', () => msg`Sign-in was cancelled, or your identity provider did not grant access.`],
  [
    'account_not_linked',
    () =>
      msg`An account with this email already exists but is not verified, so it cannot be linked to this sign-in. Ask your administrator for help.`,
  ],
  [
    'unsolicited_response',
    (appName) => msg`This sign-in did not start from ${appName}. Open ${appName} and sign in from there.`,
  ],
  // The organization's access check refused the member; codes from the backend's identity plugin.
  ['ACCESS_BLOCKED', (appName) => msg`Your access to ${appName} has been blocked. Ask your administrator for help.`],
  ['ACCESS_DEPROVISIONED', () => deactivated],
  ['ACCESS_NO_LIVE_SOURCE', () => deactivated],
  [
    'ACCESS_NOT_MEMBER',
    (appName) => msg`Your organization hasn't given you access to ${appName} yet. Ask your administrator to add you.`,
  ],
  [
    'SSO_USER_RESOLUTION_FAILED',
    () => msg`We couldn't match this sign-in to an account. Ask your administrator for help.`,
  ],
  [
    'SSO_MATCH_CLAIM_MISSING',
    () =>
      msg`Your identity provider didn't send the identifier your organization matches accounts on. Ask your administrator to check the connection.`,
  ],
  // Linking: an existing account already uses this email.
  [
    'LINK_REVIEW_PENDING',
    (appName) =>
      msg`An existing ${appName} account already uses this email. Your administrator needs to approve linking it to this sign-in.`,
  ],
  [
    'SSO_CONNECTION_UNAVAILABLE',
    () => msg`This sign-in option is no longer available. Try again, or ask your administrator.`,
  ],
])

const fallback = msg`We could not sign you in. Please try again.`

/**
 * Maps the `error` code a failed SSO login returns to the app to a message we wrote.
 * The code is untrusted URL input, so unknown codes get a generic message and are never shown.
 * Returns a descriptor for the caller to resolve with `i18n._` at render time.
 * @param code - The `error` query parameter.
 * @param appName - The deployment's app name, for copy that names it.
 */
export const getSsoErrorMessage = (code: string | null, appName: string): MessageDescriptor =>
  // OIDC returns `account not linked` with spaces; SAML already swaps them for underscores.
  messages.get(code?.replaceAll(' ', '_') ?? '')?.(appName) ?? fallback
