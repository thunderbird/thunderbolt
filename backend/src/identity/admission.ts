/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { type AuthAdapter, findMembership, type MembershipRow } from './access'
import { createAuditEvent } from './audit/write'
import { applyBootstrapAdmin, isBootstrapAdminEmail } from './bootstrap-admin'
import { findOrgDomainForEmail, getOrgDomainForEmail, isClaimedDomain, isEnrollableDomain } from './domains'
import { type Admission, addMembershipSource, createMembership } from './membership'
import { otpSignInPath, type SignIn } from './sign-in'

type AdmissionRule = (adapter: AuthAdapter, signIn: SignIn) => Promise<Admission | null>

/**
 * An email-code sign-up on a domain the org verified and opened to enrollment. Never a role grant:
 * domain joiners hold only the implicit member role.
 */
const domainRule: AdmissionRule = async (adapter, { user, path }) => {
  if (path !== otpSignInPath) {
    return null
  }
  const orgDomain = await findOrgDomainForEmail(adapter, user.email)
  return orgDomain && isEnrollableDomain(orgDomain) ? { kind: 'domain', ref: orgDomain.id } : null
}

/**
 * An email-code sign-up whose address the waitlist approved, unless an IdP connection claims its
 * domain: people there get in through that connection.
 */
const waitlistRule: AdmissionRule = async (adapter, { user, path }) => {
  if (path !== otpSignInPath || isClaimedDomain(await findOrgDomainForEmail(adapter, user.email))) {
    return null
  }
  const approval = await adapter.findOne<{ id: string }>({
    model: 'waitlist',
    where: [
      { field: 'email', value: user.email },
      { field: 'status', value: 'approved' },
    ],
  })
  return approval ? { kind: 'waitlist', ref: approval.id } : null
}

/** With open sign-up on, any email-code sign-up, except on a domain an IdP claims. */
const openRule: AdmissionRule = async (adapter, { user, path }) =>
  path === otpSignInPath &&
  getSettings().openSignupEnabled &&
  !isClaimedDomain(await findOrgDomainForEmail(adapter, user.email))
    ? { kind: 'open' }
    : null

/**
 * A subject of a connection without SCIM. A connection with SCIM admits only the subjects SCIM
 * provisioned ("require a SCIM record before first login"), so it admits nobody here.
 */
const ssoRule: AdmissionRule = async (_adapter, { ssoConnection }) =>
  ssoConnection && !ssoConnection.requiresScimRecord ? { kind: 'sso', identityConnectionId: ssoConnection.id } : null

/** Tried in order for a signing-in user with no membership; the first match admits them. */
const admissionRules: AdmissionRule[] = [domainRule, waitlistRule, openRule, ssoRule]

/**
 * The membership of a user who is signing in: the existing one, or a new one from the first
 * admission rule that matches, then the one-time bootstrap admin grant (which also admits a listed
 * address no rule matched). Null when nothing admits them. Pass the adapter of the running
 * transaction.
 */
export const admitAtSignIn = async (adapter: AuthAdapter, signIn: SignIn) => {
  const existing = await findMembership(adapter, signIn.user.id)
  if (existing) {
    await addSsoSource(adapter, existing, signIn)
  }
  return applyBootstrapAdmin(adapter, signIn, existing ?? (await admitByRule(adapter, signIn)))
}

/**
 * A connection without SCIM admits its subjects at every sign-in, members included: one whose
 * only source was this connection's retiring or retired SCIM side would otherwise be locked out of the SSO
 * side that stays. The access check still runs after, so a block or another IdP's
 * deprovisioning wins. A source an admin suspended or removed is left as it is.
 */
const addSsoSource = async (adapter: AuthAdapter, membership: MembershipRow, { user, ssoConnection }: SignIn) => {
  if (!ssoConnection || ssoConnection.requiresScimRecord) {
    return
  }
  const source = await adapter.findOne({
    model: 'membershipSource',
    where: [
      { field: 'membershipId', value: membership.id },
      { field: 'kind', value: 'sso' },
      { field: 'identityConnectionId', value: ssoConnection.id },
    ],
  })
  if (source) {
    return
  }
  await addMembershipSource(adapter, membership.id, { kind: 'sso', identityConnectionId: ssoConnection.id })
  await createAuditEvent(adapter, {
    action: 'member.source_added',
    outcome: 'success',
    actor: { type: 'user', id: user.id },
    target: { type: 'user', id: user.id },
    connectionId: ssoConnection.id,
    metadata: { kind: 'sso' },
  })
}

const admitByRule = async (adapter: AuthAdapter, signIn: SignIn) => {
  for (const rule of admissionRules) {
    const admission = await rule(adapter, signIn)
    if (admission) {
      return createMembership(adapter, signIn.user.id, admission)
    }
  }
  return null
}

/**
 * Whether a new address may get an email sign-in code without an approved waitlist row. The one
 * place this is decided: `/waitlist/join`, the OTP send and the OTP sign-in check all ask it.
 * Each case it allows has an admission rule that admits the address at sign-in.
 */
export const admitsWithoutWaitlist = async (database: typeof DbType, email: string) => {
  if (isBootstrapAdminEmail(email)) {
    return true
  }
  const orgDomain = await getOrgDomainForEmail(database, email)
  return isEnrollableDomain(orgDomain) || (getSettings().openSignupEnabled && !isClaimedDomain(orgDomain))
}
