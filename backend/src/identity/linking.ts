/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { normalizeEmail } from '@/lib/email'
import type { AuthAdapter } from './access'
import { findOrgDomainForEmail } from './domains'

/*
 * The rules for joining an incoming IdP identity to the existing user who owns its email. Email
 * never links on its own, and two existing users are never merged: a link only attaches the
 * identity to one user, whose E2EE keys stay as they are. The tiers, tried in order:
 * 1. `domain`: the email's domain is verified and claimed by the connection the identity arrives on
 * 2. `self_service`: the person, signed in to the existing user, asked to link and completed SSO
 * 3. `review`: one admin approved the link from the review queue (`link-reviews.ts`)
 */

export type LinkTier = 'domain' | 'self_service' | 'review'

export type LinkCandidate = { id: string; email: string; emailVerified: boolean }

/** The existing user an incoming identity's email names, if any. Anonymous users are never linked. */
export const findLinkCandidate = async (adapter: Pick<AuthAdapter, 'findOne'>, email: string) => {
  const existing = await adapter.findOne<LinkCandidate & { isAnonymous?: boolean | null }>({
    model: 'user',
    where: [{ field: 'email', value: normalizeEmail(email) }],
  })
  return existing && !existing.isAnonymous ? existing : null
}

/**
 * Tier 1: the email's exact domain is verified and claimed by this identity connection, so the
 * company proved it owns the domain and that this IdP speaks for it.
 */
export const isDomainClaimedByConnection = async (
  adapter: Pick<AuthAdapter, 'findOne'>,
  email: string,
  identityConnectionId: string,
) => {
  const domain = await findOrgDomainForEmail(adapter, email)
  return Boolean(domain?.verifiedAt) && domain?.claimedByConnectionId === identityConnectionId
}

/**
 * Whether the user has, or had, a SCIM record on this SCIM connection. The same IdP sending a new
 * `externalId` for that user's email (Keycloak recreating a user with a new UUID) says this is a
 * different identity, so it never links automatically.
 */
export const hasRecordOnScimConnection = async (
  adapter: Pick<AuthAdapter, 'findOne'>,
  userId: string,
  scimConnectionId: string,
) => {
  const where = [
    { field: 'connectionId', value: scimConnectionId },
    { field: 'userId', value: userId },
  ]
  return (
    (await adapter.findOne({ model: 'scimUser', where })) !== null ||
    (await adapter.findOne({ model: 'scimIdentityTombstone', where })) !== null
  )
}

/**
 * The SCIM link's profile mode. Only one source manages email and name: a user another SCIM source
 * already manages is linked with `preserve`, and the first IdP to link a local user takes it over.
 */
export const linkProfile = async (adapter: Pick<AuthAdapter, 'findOne'>, userId: string) => {
  const subject = await adapter.findOne<{ profileSourceId: string | null }>({
    model: 'scimSubject',
    where: [{ field: 'userId', value: userId }],
  })
  return subject?.profileSourceId ? 'preserve' : 'manage'
}
