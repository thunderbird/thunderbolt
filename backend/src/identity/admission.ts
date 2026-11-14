/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { membershipSourceKinds } from '@/db/schema'
import { type AuthAdapter, findMembership, type MembershipRow } from './access'
import { createAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

/** Better Auth path of an email-code sign-in. */
export const otpSignInPath = '/sign-in/email-otp'

/** Better Auth paths that finish an SSO sign-in, including the shared OIDC callback used with `redirectURI`. */
export const ssoSignInPaths: readonly string[] = [
  '/sso/callback/:providerId',
  '/sso/callback',
  '/sso/saml2/sp/acs/:providerId',
]

export type SignInUser = { id: string; email: string; emailVerified: boolean }

export type SignIn = { user: SignInUser; path: string | undefined }

type Admission = {
  kind: (typeof membershipSourceKinds)[number]
  ref?: string | null
  identityConnectionId?: string | null
}

type AdmissionRule = (adapter: AuthAdapter, signIn: SignIn) => Promise<Admission | null>

/** An email-code sign-up whose address the waitlist approved. */
const waitlistRule: AdmissionRule = async (adapter, { user, path }) => {
  if (path !== otpSignInPath) {
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

/** Any subject of the deployment's SSO provider, as before organizations existed. */
const ssoRule: AdmissionRule = async (_adapter, { path }) =>
  path !== undefined && ssoSignInPaths.includes(path) ? { kind: 'sso' } : null

/** Tried in order for a signing-in user with no membership; the first match admits them. */
const admissionRules: AdmissionRule[] = [waitlistRule, ssoRule]

/** Create a membership with its first source, and record the admission. */
export const createMembership = async (adapter: AuthAdapter, userId: string, admission: Admission) => {
  const orgId = getCurrentOrganizationId()
  const membership = await adapter.create<Record<string, unknown>, MembershipRow>({
    model: 'orgMembership',
    data: { orgId, userId },
  })
  await addMembershipSource(adapter, membership.id, admission)
  await createAuditEvent(adapter, {
    action: 'member.admitted',
    outcome: 'success',
    actor: { type: 'user', id: userId },
    target: { type: 'user', id: userId },
    connectionId: admission.identityConnectionId ?? null,
    metadata: { kind: admission.kind },
  })
  return membership
}

/** Add a source to an existing membership. */
export const addMembershipSource = (adapter: AuthAdapter, membershipId: string, admission: Admission) =>
  adapter.create({
    model: 'membershipSource',
    data: {
      orgId: getCurrentOrganizationId(),
      membershipId,
      kind: admission.kind,
      ref: admission.ref ?? null,
      identityConnectionId: admission.identityConnectionId ?? null,
    },
  })

/**
 * The membership of a user who is signing in: the existing one, or a new one from the first
 * admission rule that matches. Null when nothing admits them. Pass the adapter of the running
 * transaction.
 */
export const admitAtSignIn = async (adapter: AuthAdapter, signIn: SignIn) => {
  const existing = await findMembership(adapter, signIn.user.id)
  if (existing) {
    return existing
  }
  for (const rule of admissionRules) {
    const admission = await rule(adapter, signIn)
    if (admission) {
      return createMembership(adapter, signIn.user.id, admission)
    }
  }
  return null
}
