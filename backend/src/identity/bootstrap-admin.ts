/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getBootstrapAdminEmails, getSettings } from '@/config/settings'
import { normalizeEmail } from '@/lib/email'
import type { AuthAdapter, MembershipRow } from './access'
import { createAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'
import { addMembershipSource, createMembership } from './membership'
import { adminRole } from './roles'
import { otpSignInPath, type SignIn, ssoSignInPaths } from './sign-in'

/** Whether `BOOTSTRAP_ADMIN_EMAILS` lists this address. */
export const isBootstrapAdminEmail = (email: string) =>
  getBootstrapAdminEmails(getSettings()).includes(normalizeEmail(email))

/**
 * An email-code sign-in proves the address, and so does an SSO sign-in unless the provider says the
 * address is unverified. Any other sign-in counts once the address was verified.
 */
const isVerifiedSignIn = ({ user, path, idpDeniedEmailVerified }: SignIn) =>
  path === otpSignInPath ||
  (path !== undefined && ssoSignInPaths.includes(path) && !idpDeniedEmailVerified) ||
  user.emailVerified

/**
 * Grant the admin role, once per address, to a listed email at its first verified sign-in, by any
 * method. The `bootstrap` membership source is the marker: once it exists the address is never
 * granted again, so removing the role, or removing the email and restarting, sticks. Creates the
 * membership when nothing else admitted the address. Returns the membership.
 */
export const applyBootstrapAdmin = async (
  adapter: AuthAdapter,
  signIn: SignIn,
  membership: MembershipRow | null,
): Promise<MembershipRow | null> => {
  const email = normalizeEmail(signIn.user.email)
  if (!isBootstrapAdminEmail(email) || !isVerifiedSignIn(signIn)) {
    return membership
  }
  const orgId = getCurrentOrganizationId()
  const applied = await adapter.findOne({
    model: 'membershipSource',
    where: [
      { field: 'orgId', value: orgId },
      { field: 'kind', value: 'bootstrap' },
      { field: 'ref', value: email },
    ],
  })
  if (applied) {
    return membership
  }

  const admission = { kind: 'bootstrap', ref: email } as const
  const target = membership ?? (await createMembership(adapter, signIn.user.id, admission))
  if (membership) {
    await addMembershipSource(adapter, membership.id, admission)
  }
  const existingGrant = await adapter.findOne({
    model: 'memberRoleGrant',
    where: [
      { field: 'membershipId', value: target.id },
      { field: 'role', value: adminRole },
    ],
  })
  if (!existingGrant) {
    await adapter.create({
      model: 'memberRoleGrant',
      data: { orgId, membershipId: target.id, role: adminRole, source: 'bootstrap' },
    })
  }
  await createAuditEvent(adapter, {
    action: 'member.bootstrap_admin_granted',
    outcome: 'success',
    actor: { type: 'system' },
    target: { type: 'user', id: signIn.user.id },
  })
  return target
}
