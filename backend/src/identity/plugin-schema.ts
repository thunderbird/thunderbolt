/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BetterAuthPluginDBSchema, DBFieldAttribute } from '@better-auth/core/db'

/*
 * Better Auth's view of the tables in `@/db/identity-schema`, so hooks and SCIM callbacks can reach
 * them through the auth adapter (and its transaction). Migrations come only from Drizzle; Better
 * Auth's runtime schema check fails every auth call if a column here is missing from Drizzle, or
 * Drizzle gains a required column this list doesn't write. Columns with a database default are
 * optional here, so an insert that omits them takes the default.
 */

const text = (required = true): DBFieldAttribute => ({ type: 'string', required })
const flag = (required = true): DBFieldAttribute => ({ type: 'boolean', required })
const date = (required = true): DBFieldAttribute => ({ type: 'date', required })
const json = (): DBFieldAttribute => ({ type: 'json', required: false })
const ref = (model: string, required = true): DBFieldAttribute => ({
  type: 'string',
  required,
  references: { model, field: 'id' },
})

const created = { createdAt: date(false) }
const timestamps = { createdAt: date(false), updatedAt: date(false) }

export const identityPluginSchema = {
  organization: { fields: { name: text(), slug: text(), ...timestamps } },
  orgMembership: {
    fields: {
      orgId: ref('organization'),
      userId: ref('user'),
      blockedAt: date(false),
      blockedBy: ref('user', false),
      blockReason: text(false),
      ...timestamps,
    },
  },
  identityConnection: {
    fields: {
      orgId: ref('organization'),
      name: text(),
      ssoProviderId: text(false),
      scimConnectionId: text(false),
      matchClaim: text(false),
      status: text(false),
      retireRequestedAt: date(false),
      retiredAt: date(false),
      retiredBy: ref('user', false),
      createdBy: ref('user', false),
      ...timestamps,
    },
  },
  membershipSource: {
    fields: {
      orgId: ref('organization'),
      membershipId: ref('orgMembership'),
      kind: text(),
      status: text(false),
      identityConnectionId: ref('identityConnection', false),
      ref: text(false),
      statusChangedAt: date(false),
      ...timestamps,
    },
  },
  memberRoleGrant: {
    fields: {
      orgId: ref('organization'),
      membershipId: ref('orgMembership'),
      role: text(),
      source: text(),
      grantedBy: ref('user', false),
      ...created,
    },
  },
  invitation: {
    fields: {
      orgId: ref('organization'),
      email: text(),
      tokenHash: text(),
      status: text(false),
      expiresAt: date(),
      proposedRole: text(false),
      idpOverride: flag(false),
      invitedBy: ref('user', false),
      acceptedByUserId: ref('user', false),
      acceptedAt: date(false),
      revokedAt: date(false),
      revokedBy: ref('user', false),
      ...timestamps,
    },
  },
  orgDomain: {
    fields: {
      orgId: ref('organization'),
      domain: text(),
      verificationToken: text(),
      verifiedAt: date(false),
      lastCheckedAt: date(false),
      lastCheckError: text(false),
      enrollmentEnabled: flag(false),
      enrollmentRole: text(false),
      claimedByConnectionId: ref('identityConnection', false),
      createdBy: ref('user', false),
      ...timestamps,
    },
  },
  linkReview: {
    fields: {
      orgId: ref('organization'),
      identityConnectionId: ref('identityConnection'),
      trigger: text(),
      externalId: text(),
      incomingEmail: text(),
      incomingName: text(false),
      candidateUserId: ref('user'),
      status: text(false),
      resolvedBy: ref('user', false),
      resolvedAt: date(false),
      attempts: { type: 'number', required: false },
      lastSeenAt: date(false),
      ...timestamps,
    },
  },
  localGroup: {
    fields: {
      orgId: ref('organization'),
      name: text(),
      description: text(false),
      createdBy: ref('user', false),
      ...timestamps,
    },
  },
  localGroupMember: {
    fields: {
      orgId: ref('organization'),
      localGroupId: ref('localGroup'),
      membershipId: ref('orgMembership'),
      addedBy: ref('user', false),
      ...created,
    },
  },
  groupRoleMapping: {
    fields: {
      orgId: ref('organization'),
      localGroupId: ref('localGroup', false),
      identityConnectionId: ref('identityConnection', false),
      scimGroupId: text(false),
      role: text(),
      createdBy: ref('user', false),
      ...created,
    },
  },
  auditEvent: {
    fields: {
      orgId: ref('organization'),
      occurredAt: date(false),
      action: text(),
      outcome: text(),
      reason: text(false),
      actorType: text(),
      actorId: text(false),
      targetType: text(false),
      targetId: text(false),
      connectionId: text(false),
      credentialId: text(false),
      requestId: text(false),
      reportSource: text(false),
      changes: json(),
      metadata: json(),
      ipAddress: text(false),
      userAgent: text(false),
    },
  },
  // Not an identity table: declared so the waitlist admission rule can read approvals in the
  // sign-in transaction.
  waitlist: { fields: { email: text(), status: text(false), batchId: text(false), ...timestamps } },
} satisfies BetterAuthPluginDBSchema
