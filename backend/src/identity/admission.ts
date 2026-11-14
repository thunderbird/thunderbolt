/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { type AuthAdapter, findMembership } from './access'
import { applyBootstrapAdmin, isBootstrapAdminEmail } from './bootstrap-admin'
import { type Admission, createMembership } from './membership'
import { otpSignInPath, type SignIn, ssoSignInPaths } from './sign-in'

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

/**
 * The membership of a user who is signing in: the existing one, or a new one from the first
 * admission rule that matches, then the one-time bootstrap admin grant (which also admits a listed
 * address no rule matched). Null when nothing admits them. Pass the adapter of the running
 * transaction.
 */
export const admitAtSignIn = async (adapter: AuthAdapter, signIn: SignIn) => {
  const membership = (await findMembership(adapter, signIn.user.id)) ?? (await admitByRule(adapter, signIn))
  return applyBootstrapAdmin(adapter, signIn, membership)
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
 * Each case it allows has an admission rule that admits the address at sign-in. Async and given
 * the database because invitations and approved domains will be looked up here.
 */
export const admitsWithoutWaitlist = async (_database: typeof DbType, email: string) => isBootstrapAdminEmail(email)
