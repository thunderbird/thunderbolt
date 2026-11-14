/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { normalizeEmail } from '@/lib/email'
import { sso, type SSOOptions } from '@better-auth/sso'
import type { User } from 'better-auth'
import { type AuthAdapter, findMembership } from './access'
import { recordIdpDeniedEmailVerified, recordSsoConnection } from './sign-in'
import { envSsoProvider, findSsoConnection, isSsoAuthMode, requiresScimRecord } from './sso-connections'

type SsoRequest = Partial<Record<'body' | 'params' | 'query', { providerId?: unknown }>>

/** The SSO routes the app uses, each with the part of the request that names the provider. */
const ssoRouteProviderPart = new Map<string, keyof SsoRequest>([
  ['/sign-in/sso', 'body'],
  ['/sso/callback/:providerId', 'params'],
  ['/sso/saml2/sp/acs/:providerId', 'params'],
  ['/sso/saml2/sp/metadata', 'query'],
])

/**
 * Better Auth still reads `sso_provider` rows that older releases let any signed-in user
 * register, and a row's owner holds its IdP. An SSO route outside the table above, or one that
 * doesn't name the provider of a live connection, is refused, so such a row can neither sign in
 * nor be edited, and nobody can register a provider.
 */
export const isForeignSsoRequest = async (adapter: AuthAdapter, path: string, request: SsoRequest) => {
  if (path !== '/sign-in/sso' && !path.startsWith('/sso/')) {
    return false
  }
  const part = ssoRouteProviderPart.get(path)
  const providerId = part && request[part]?.providerId
  return typeof providerId !== 'string' || (await findSsoConnection(adapter, providerId)) === null
}

type SsoUserResolution = Parameters<NonNullable<SSOOptions['resolveUser']>>[0]

/** True when an OIDC provider states it never confirmed the address. SAML carries no such claim. */
const idpDeniesEmailVerified = (input: SsoUserResolution) =>
  input.protocol === 'oidc' &&
  [input.verifiedIdTokenClaims, input.providerClaims].some(
    (claims) => claims.email_verified === false || claims.email_verified === 'false',
  )

/**
 * Whether a SCIM connection manages the user, in any status: a `scim` membership source, or the SCIM
 * plugin's own link, which exists from the moment SCIM creates the user. Read through the sign-in's
 * transaction adapter: a query on another connection would wait on that transaction under PGlite.
 */
const isScimManaged = async (adapter: AuthAdapter, userId: string) => {
  const byUser = [{ field: 'userId', value: userId }]
  if (
    (await adapter.findOne({ model: 'scimUser', where: byUser })) ||
    (await adapter.findOne({ model: 'scimSubject', where: byUser }))
  ) {
    return true
  }
  const membership = await findMembership(adapter, userId)
  if (!membership) {
    return false
  }
  const source = await adapter.findOne({
    model: 'membershipSource',
    where: [
      { field: 'membershipId', value: membership.id },
      { field: 'kind', value: 'scim' },
    ],
  })
  return source !== null
}

/**
 * Resolve an SSO sign-in. Records the connection it came through, for admission. On a connection
 * without SCIM, signs a new identity into the existing user with the same email when that user
 * verified it by email code, or already signed in through this connection (a new subject or SAML
 * NameID for the same person). We trust a connection's IdP once Better Auth has checked the SAML
 * signature or OIDC id_token, unless it says the email is unverified. Never links by email on a
 * connection with SCIM, or to a user a SCIM connection manages: an IdP-managed member is reached
 * only through their SCIM record. See backend/docs/authentication.md.
 */
const resolveSsoUser: NonNullable<SSOOptions['resolveUser']> = async (input, { database: adapter }) => {
  const connection = await findSsoConnection(adapter, input.providerId)
  if (!connection) {
    return { action: 'reject', code: 'SSO_CONNECTION_UNAVAILABLE' }
  }
  const scimRecordRequired = requiresScimRecord(connection)
  await recordSsoConnection({ id: connection.id, requiresScimRecord: scimRecordRequired })

  const hasSsoAccount = async (field: 'accountId' | 'userId', value: string) =>
    (await adapter.findOne({
      model: 'account',
      where: [
        { field: 'providerId', value: input.providerId },
        { field, value },
      ],
    })) !== null
  // This runs on every sign-in, before Better Auth finds a known identity's own user.
  const emailUnverified = idpDeniesEmailVerified(input)
  if (emailUnverified) {
    // The bootstrap admin grant needs it later in this sign-in; the user row can't carry it.
    await recordIdpDeniedEmailVerified()
  }
  if (emailUnverified || scimRecordRequired || (await hasSsoAccount('accountId', input.accountKey.accountId))) {
    return { action: 'continue' }
  }
  const existing = await adapter.findOne<User>({
    model: 'user',
    where: [{ field: 'email', value: normalizeEmail(input.providerUser.email) }],
  })
  if (!existing || (await isScimManaged(adapter, existing.id))) {
    return { action: 'continue' }
  }
  return existing.emailVerified || (await hasSsoAccount('userId', existing.id))
    ? { action: 'link', userId: existing.id, profile: 'preserve' }
    : { action: 'continue' }
}

/**
 * The SSO plugin, in SSO mode. Providers come only from `sso_provider` rows paired with an
 * `identity_connection` (see `sso-connections.ts`); the env provider is one of them. Throws when
 * SSO mode is on and its env is incomplete.
 */
export const buildSsoPlugins = (settings: Settings) => {
  if (!isSsoAuthMode(settings)) {
    return []
  }
  envSsoProvider(settings)
  return [
    sso({
      // Refuses `/sso/register` to every caller. isForeignSsoRequest refuses the route too; this
      // holds even if that check ever lets it through.
      providersLimit: 0,
      resolveUser: resolveSsoUser,
      // Without a callback, a response with no RelayState (IdP-initiated) lands on the API origin, not the app.
      saml: { allowIdpInitiated: settings.samlAllowIdpInitiated, idpInitiatedCallbackUrl: settings.appUrl },
    }),
  ]
}
