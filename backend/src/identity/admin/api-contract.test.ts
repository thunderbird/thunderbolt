/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  auditEvent,
  identityConnectionStatuses,
  membershipSourceKinds,
  membershipSourceStatuses,
} from '@/db/schema'
import type * as Api from '@shared/admin-api'
import { describe, expect, it } from 'bun:test'
import type { AccessDecision, AccessRefusal } from '../access'
import type { DomainCheckError } from '../domains'
import type { SsoLockableField, SsoSettings } from '../sso-connections'
import type { approveLinkReview, listLinkReviews } from '../link-reviews'
import type { adminRole, assignableRoles } from '../roles'
import type { createScimConnection, rotateScimCredential } from '../scim/connections'
import type { DomainView, InvitationView } from './admission'
import type { ConnectionView, getConnection } from './connections'
import type { LocalGroupMemberView, LocalGroupView, RoleMappingView, ScimGroupView } from './groups'
import type { BreakGlassStatus, breakGlassWarning, idpManagedFields, MemberView } from './members'
import type { Page } from './pagination'

/** What JSON makes of a value: a `Date` arrives as its ISO string. */
type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Wire<Item>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T

/** Compiles only when the two types accept exactly the same values. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const contract = <T extends true>() => true as T

type Resolved<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>

/**
 * The admin services' responses against `shared/admin-api.ts`. The assertions are types: a drift on
 * either side fails `tsc`. The runtime check only gives bun something to run.
 */
describe('admin API contract', () => {
  it('matches the shared types', () => {
    const checks = [
      contract<Same<typeof adminRole, typeof Api.adminRole>>(),
      contract<Same<(typeof assignableRoles)[number], Api.AssignableRole>>(),
      contract<Same<Wire<Page<string>>, Api.Page<string>>>(),
      contract<Same<Resolved<typeof breakGlassWarning>, Api.BreakGlassWarning>>(),
      contract<Same<BreakGlassStatus, Api.BreakGlassStatus>>(),
      // Members
      contract<Same<AccessRefusal, Api.AccessRefusal>>(),
      contract<Same<AccessDecision, Api.AccessDecision>>(),
      contract<Same<(typeof membershipSourceKinds)[number], Api.MembershipSourceKind>>(),
      contract<Same<(typeof membershipSourceStatuses)[number], Api.MembershipSourceStatus>>(),
      contract<Same<(typeof idpManagedFields)[number], Api.IdpManagedField>>(),
      contract<Same<Wire<MemberView>, Api.AdminMember>>(),
      // Groups
      contract<Same<Wire<LocalGroupView>, Api.LocalGroup>>(),
      contract<Same<Wire<LocalGroupMemberView>, Api.LocalGroupMember>>(),
      contract<Same<Wire<RoleMappingView>, Api.RoleMapping>>(),
      contract<Same<Wire<ScimGroupView>, Api.ScimGroup>>(),
      // Connections
      contract<Same<(typeof identityConnectionStatuses)[number], Api.ConnectionStatus>>(),
      contract<Same<Wire<ConnectionView>, Api.AdminConnection>>(),
      contract<Same<SsoSettings, Api.SsoSettings>>(),
      contract<Same<SsoLockableField, Api.SsoLockableField>>(),
      contract<Same<Wire<Resolved<typeof getConnection>>, Api.AdminConnectionDetail>>(),
      contract<Same<Wire<Resolved<typeof createScimConnection>>, Api.CreateScimConnectionResponse>>(),
      contract<Same<Wire<Resolved<typeof rotateScimCredential>>, Api.RotateScimCredentialResponse>>(),
      // Admission
      contract<Same<Wire<InvitationView>, Api.Invitation>>(),
      contract<Same<Wire<DomainView>, Api.OrgDomain>>(),
      contract<Same<DomainCheckError, Api.DomainCheckError>>(),
      contract<Same<Wire<Resolved<typeof listLinkReviews>>, Api.LinkReviewPage>>(),
      contract<Same<Wire<Resolved<typeof approveLinkReview>>, Api.LinkReviewRecord>>(),
      // Audit
      contract<Same<Wire<typeof auditEvent.$inferSelect>, Api.AuditEvent>>(),
    ]
    expect(checks.every(Boolean)).toBe(true)
  })
})
