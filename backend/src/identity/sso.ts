/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { acquireActiveSCIMUserLink } from '@better-auth/scim'
import { sso, type SSOOptions } from '@better-auth/sso'
import { type AuthAdapter, findMembership } from './access'
import { createAuditEvent } from './audit/write'
import { findApprovedLinkReview, markLinkReviewLinked } from './link-reviews'
import { findLinkCandidate, isDomainClaimedByConnection, type LinkTier } from './linking'
import { recordIdpDeniedEmailVerified, recordSsoConnection } from './sign-in'
import { requestSsoLinkReview, ssoLinking } from './sso-linking'
import {
  envSsoProvider,
  findSsoConnection,
  isSsoAuthMode,
  requiresScimRecord,
  type SsoConnection,
} from './sso-connections'

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

type SsoResolverDatabase = Parameters<NonNullable<SSOOptions['resolveUser']>>[1]['database']

/** True when an OIDC provider states it never confirmed the address. SAML carries no such claim. */
const idpDeniesEmailVerified = (input: SsoUserResolution) =>
  input.protocol === 'oidc' &&
  [input.verifiedIdTokenClaims, input.providerClaims].some(
    (claims) => claims.email_verified === false || claims.email_verified === 'false',
  )

/**
 * The value of the connection's match claim on this sign-in: the OIDC `sub` or SAML NameID for
 * `sub`, otherwise the named id_token claim or SAML attribute (its first value). It names the
 * subject's SCIM record, whose `externalId` must equal it.
 */
const matchClaimValue = (input: SsoUserResolution, matchClaim: string) => {
  if (matchClaim === 'sub') {
    return input.accountKey.accountId
  }
  const value =
    input.protocol === 'oidc' ? input.verifiedIdTokenClaims[matchClaim] : input.providerAttributes[matchClaim]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first !== '' ? first : null
}

/**
 * Sign a subject of a connection with SCIM into the user its SCIM record names, matched on the
 * connection's claim and never on email. A record that is deactivated or deleted refuses the
 * sign-in. With no record at all the sign-in continues, and admission refuses the new user unless
 * the bootstrap admin grant admits it.
 */
const resolveThroughScimRecord = async (
  database: SsoResolverDatabase,
  input: SsoUserResolution,
  { id, scimConnectionId, matchClaim }: Pick<SsoConnection, 'id' | 'matchClaim'> & { scimConnectionId: string },
) => {
  const externalId = matchClaimValue(input, matchClaim)
  if (!externalId) {
    return { action: 'reject', code: 'SSO_MATCH_CLAIM_MISSING' } as const
  }
  const link = await acquireActiveSCIMUserLink({ connectionId: scimConnectionId, externalId }, { database })
  if (link) {
    // A returning subject already has its account; only its first sign-in links one.
    if ((await findSsoAccountUserId(database, input.providerId, input.accountKey.accountId)) === null) {
      await recordSsoLink(database, { userId: link.userId, connectionId: id, via: 'scim_record' })
    }
    return { action: 'link', userId: link.userId, profile: 'preserve' } as const
  }
  const byExternalId = [
    { field: 'connectionId', value: scimConnectionId },
    { field: 'externalId', value: externalId },
  ]
  const deprovisioned =
    (await database.findOne({ model: 'scimUser', where: byExternalId })) ??
    (await database.findOne({ model: 'scimIdentityTombstone', where: byExternalId }))
  return deprovisioned
    ? ({ action: 'reject', code: 'ACCESS_DEPROVISIONED' } as const)
    : ({ action: 'continue' } as const)
}

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
 * How an SSO sign-in linked a new identity to an existing user: one of the linking tiers, the
 * subject's SCIM record, or the email rules of a connection without SCIM.
 */
type SsoLinkVia = LinkTier | 'scim_record' | 'email'

/** Record a link an SSO sign-in makes, in its transaction, so it rolls back with a refused sign-in. */
const recordSsoLink = (
  adapter: AuthAdapter,
  { userId, connectionId, via, reviewId }: { userId: string; connectionId: string; via: SsoLinkVia; reviewId?: string },
) =>
  createAuditEvent(adapter, {
    action: 'link.created',
    outcome: 'success',
    actor: { type: 'system' },
    target: { type: 'user', id: userId },
    connectionId,
    metadata: { tier: via, ...(reviewId ? { reviewId } : {}) },
  })

/** The user that already holds this subject on this provider, if any. */
const findSsoAccountUserId = async (adapter: AuthAdapter, providerId: string, accountId: string) =>
  (
    await adapter.findOne<{ userId: string }>({
      model: 'account',
      where: [
        { field: 'providerId', value: providerId },
        { field: 'accountId', value: accountId },
      ],
    })
  )?.userId ?? null

/** Whether the user already signs in through an SSO provider other than this one. */
const hasOtherSsoAccount = async (adapter: AuthAdapter, userId: string, providerId: string) => {
  const accounts = await adapter.findMany<{ providerId: string }>({
    model: 'account',
    where: [
      { field: 'userId', value: userId },
      { field: 'providerId', value: providerId, operator: 'ne' },
    ],
  })
  for (const { providerId: other } of accounts) {
    if (await adapter.findOne({ model: 'ssoProvider', where: [{ field: 'providerId', value: other }] })) {
      return true
    }
  }
  return false
}

/**
 * Resolve an SSO sign-in. Records the connection it came through, for admission. Then, in order:
 * - on a connection with SCIM, the subject signs into the user of the SCIM record its match claim
 *   names, never by email. An approved review attaches through the IdP's SCIM retry instead
 * - on a connection without SCIM, an approved review's user; otherwise a new identity whose email
 *   an existing user owns:
 *   - is never linked when the IdP says the email is unverified, or the user is SCIM-managed
 *   - goes through the tiers when the user already signs in through another SSO provider, so one
 *     IdP can't take over a user another IdP signs in: linked when the domain is verified and
 *     claimed by this connection, refused into the review queue otherwise
 *   - otherwise links when the user verified the email by email code, or already signed in through
 *     this connection (a new subject or SAML NameID for the same person)
 * We trust a connection's IdP once Better Auth has checked the SAML signature or OIDC id_token.
 * See backend/docs/authentication.md.
 */
const resolveSsoUser: NonNullable<SSOOptions['resolveUser']> = async (input, { database: adapter }) => {
  const connection = await findSsoConnection(adapter, input.providerId)
  if (!connection) {
    return { action: 'reject', code: 'SSO_CONNECTION_UNAVAILABLE' }
  }
  const scimRecordRequired = requiresScimRecord(connection)
  await recordSsoConnection({ id: connection.id, requiresScimRecord: scimRecordRequired })

  // This runs on every sign-in, before Better Auth finds a known identity's own user.
  const emailUnverified = idpDeniesEmailVerified(input)
  if (emailUnverified) {
    // The bootstrap admin grant needs it later in this sign-in; the user row can't carry it.
    await recordIdpDeniedEmailVerified()
  }
  if (scimRecordRequired && connection.scimConnectionId) {
    return resolveThroughScimRecord(adapter, input, {
      ...connection,
      scimConnectionId: connection.scimConnectionId,
    })
  }

  const hasSsoAccount = async (field: 'accountId' | 'userId', value: string) =>
    (await adapter.findOne({
      model: 'account',
      where: [
        { field: 'providerId', value: input.providerId },
        { field, value },
      ],
    })) !== null
  if (await hasSsoAccount('accountId', input.accountKey.accountId)) {
    return { action: 'continue' }
  }
  const reviewKey = matchClaimValue(input, connection.matchClaim) ?? input.accountKey.accountId
  const approved = await resolveThroughApprovedReview(adapter, connection.id, reviewKey)
  if (approved.action !== 'continue' || emailUnverified) {
    return approved
  }
  const existing = await findLinkCandidate(adapter, input.providerUser.email)
  if (!existing || (await isScimManaged(adapter, existing.id))) {
    return { action: 'continue' }
  }
  if (await hasOtherSsoAccount(adapter, existing.id, input.providerId)) {
    if (await isDomainClaimedByConnection(adapter, existing.email, connection.id)) {
      await recordSsoLink(adapter, { userId: existing.id, connectionId: connection.id, via: 'domain' })
      return { action: 'link', userId: existing.id, profile: 'preserve' }
    }
    await requestSsoLinkReview({
      identityConnectionId: connection.id,
      trigger: 'sso_sign_in',
      externalId: reviewKey,
      incomingEmail: input.providerUser.email,
      incomingName: input.providerUser.name || null,
      candidateUserId: existing.id,
    })
    return { action: 'reject', code: 'LINK_REVIEW_PENDING' }
  }
  if (!existing.emailVerified && !(await hasSsoAccount('userId', existing.id))) {
    return { action: 'continue' }
  }
  await recordSsoLink(adapter, { userId: existing.id, connectionId: connection.id, via: 'email' })
  return { action: 'link', userId: existing.id, profile: 'preserve' }
}

/** Tier 3 on SSO: sign the subject into the user an admin approved linking it to. */
const resolveThroughApprovedReview = async (adapter: AuthAdapter, connectionId: string, externalId: string | null) => {
  const review = externalId
    ? await findApprovedLinkReview(adapter, { identityConnectionId: connectionId, externalId })
    : null
  if (!review) {
    return { action: 'continue' } as const
  }
  await markLinkReviewLinked(adapter, review.id)
  await recordSsoLink(adapter, { userId: review.candidateUserId, connectionId, via: 'review', reviewId: review.id })
  return { action: 'link', userId: review.candidateUserId, profile: 'preserve' } as const
}

/**
 * The SSO plugin, in SSO mode. Providers come only from `sso_provider` rows paired with an
 * `identity_connection` (see `sso-connections.ts`); the env provider is one of them. Throws when
 * SSO mode is on and its env is incomplete.
 */
export const buildSsoPlugins = (settings: Settings, database: typeof DbType) => {
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
    ssoLinking(database),
  ]
}
