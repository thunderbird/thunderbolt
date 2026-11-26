/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { ssoProvider, user } from './auth-schema'

/*
 * Organization identity tables: members, how each got in, connections, admission, groups, roles
 * and the audit log. Server-only, never synced through PowerSync. Every table carries `org_id`
 * and scopes its uniqueness to it: the model holds many orgs while a deployment runs one
 * (`backend/src/identity/organization.ts`). The Better Auth plugin in `backend/src/identity`
 * declares the same columns so its hooks can reach these tables through the auth adapter.
 */

export const membershipSourceKinds = [
  'scim',
  'sso',
  'invitation',
  'domain',
  'waitlist',
  'open',
  'local',
  'bootstrap',
] as const

export const membershipSourceStatuses = ['active', 'suspended', 'removed'] as const

export const identityConnectionStatuses = ['active', 'scim_retiring', 'scim_retired', 'retired'] as const

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

/** One row per (org, user). Access is computed from its sources; only a local block is stored here. */
export const orgMembership = pgTable(
  'org_membership',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    blockedAt: timestamp('blocked_at'),
    blockedBy: text('blocked_by').references(() => user.id, { onDelete: 'set null' }),
    blockReason: text('block_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique('org_membership_org_id_user_id_unique').on(table.orgId, table.userId),
    index('org_membership_user_id_idx').on(table.userId),
  ],
)

/**
 * One row per IdP integration. The row is the pairing of an SSO side (`sso_provider_id`) and a SCIM
 * side (`scim_connection_id`, the plugin's connection id); either may be absent. "Require a SCIM
 * record before first login" is `scim_connection_id is not null`. `scim_retiring`/`scim_retired`
 * retire the SCIM side while SSO stays; `retired` retires both.
 */
export const identityConnection = pgTable(
  'identity_connection',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    ssoProviderId: text('sso_provider_id').references(() => ssoProvider.id, { onDelete: 'set null' }),
    scimConnectionId: text('scim_connection_id'),
    // `oid` for Entra, `sub` for Okta and Keycloak, or a SAML attribute name.
    matchClaim: text('match_claim').default('sub').notNull(),
    status: text('status', { enum: identityConnectionStatuses }).default('active').notNull(),
    retireRequestedAt: timestamp('retire_requested_at'),
    retiredAt: timestamp('retired_at'),
    retiredBy: text('retired_by').references(() => user.id, { onDelete: 'set null' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique('identity_connection_org_id_sso_provider_id_unique').on(table.orgId, table.ssoProviderId),
    unique('identity_connection_org_id_scim_connection_id_unique').on(table.orgId, table.scimConnectionId),
    uniqueIndex('identity_connection_org_id_name_uidx').on(table.orgId, sql`lower(${table.name})`),
  ],
)

/**
 * One row per way a member got in. `ref` names what admitted them: the plugin's `scimUser.id`,
 * an invitation, an org domain, a waitlist row, or the normalized email for `bootstrap` (whose row
 * is also the once-per-email marker).
 */
export const membershipSource = pgTable(
  'membership_source',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    membershipId: text('membership_id')
      .notNull()
      .references(() => orgMembership.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: membershipSourceKinds }).notNull(),
    status: text('status', { enum: membershipSourceStatuses }).default('active').notNull(),
    identityConnectionId: text('identity_connection_id').references(() => identityConnection.id, {
      onDelete: 'restrict',
    }),
    ref: text('ref'),
    statusChangedAt: timestamp('status_changed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique('membership_source_kind_unique')
      .on(table.orgId, table.membershipId, table.kind, table.identityConnectionId)
      .nullsNotDistinct(),
    uniqueIndex('membership_source_bootstrap_ref_uidx')
      .on(table.orgId, table.ref)
      .where(sql`${table.kind} = 'bootstrap'`),
    index('membership_source_membership_id_idx').on(table.membershipId),
    index('membership_source_connection_ref_idx').on(table.orgId, table.identityConnectionId, table.ref),
  ],
)

/** Local role grants. Roles from groups come through `group_role_mapping` and SCIM projection grants. */
export const memberRoleGrant = pgTable(
  'member_role_grant',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    membershipId: text('membership_id')
      .notNull()
      .references(() => orgMembership.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    source: text('source', { enum: ['local', 'bootstrap'] }).notNull(),
    grantedBy: text('granted_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [unique('member_role_grant_role_unique').on(table.orgId, table.membershipId, table.role)],
)

/** Single-use, expiring invitations. Only the token's hash is stored. */
export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status', { enum: ['pending', 'accepted', 'revoked'] })
      .default('pending')
      .notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    proposedRole: text('proposed_role'),
    // An admin's audited override for an address on an IdP-claimed domain.
    idpOverride: boolean('idp_override').default(false).notNull(),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedByUserId: text('accepted_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at'),
    revokedAt: timestamp('revoked_at'),
    revokedBy: text('revoked_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('invitation_pending_email_uidx')
      .on(table.orgId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
)

/**
 * Org domains, matched exactly (subdomains are never implied). A domain claimed by an IdP
 * connection is closed to domain enrollment. A verified domain belongs to one org.
 */
export const orgDomain = pgTable(
  'org_domain',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    domain: text('domain').notNull(),
    verificationToken: text('verification_token').notNull(),
    verifiedAt: timestamp('verified_at'),
    lastCheckedAt: timestamp('last_checked_at'),
    lastCheckError: text('last_check_error'),
    enrollmentEnabled: boolean('enrollment_enabled').default(false).notNull(),
    enrollmentRole: text('enrollment_role').default('member').notNull(),
    claimedByConnectionId: text('claimed_by_connection_id').references(() => identityConnection.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique('org_domain_org_id_domain_unique').on(table.orgId, table.domain),
    uniqueIndex('org_domain_verified_domain_uidx')
      .on(table.domain)
      .where(sql`${table.verifiedAt} is not null`),
  ],
)

/** Collisions waiting for one admin's decision, written when an incoming identity can't be linked automatically. */
export const linkReview = pgTable(
  'link_review',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    identityConnectionId: text('identity_connection_id')
      .notNull()
      .references(() => identityConnection.id, { onDelete: 'restrict' }),
    trigger: text('trigger', { enum: ['scim_create_conflict', 'sso_sign_in'] }).notNull(),
    externalId: text('external_id').notNull(),
    incomingEmail: text('incoming_email').notNull(),
    incomingName: text('incoming_name'),
    candidateUserId: text('candidate_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'linked'] })
      .default('pending')
      .notNull(),
    resolvedBy: text('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at'),
    attempts: integer('attempts').default(1).notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('link_review_open_uidx')
      .on(table.orgId, table.identityConnectionId, table.externalId)
      .where(sql`${table.status} in ('pending', 'approved')`),
  ],
)

export const localGroup = pgTable(
  'local_group',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('local_group_org_id_name_uidx').on(table.orgId, sql`lower(${table.name})`)],
)

export const localGroupMember = pgTable(
  'local_group_member',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    localGroupId: text('local_group_id')
      .notNull()
      .references(() => localGroup.id, { onDelete: 'cascade' }),
    membershipId: text('membership_id')
      .notNull()
      .references(() => orgMembership.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('local_group_member_unique').on(table.orgId, table.localGroupId, table.membershipId),
    index('local_group_member_membership_id_idx').on(table.membershipId),
  ],
)

/**
 * Maps a local group, or a SCIM group by its stable plugin id (never its name), to a role.
 * `scim_group_id` has no foreign key: the plugin owns `scim_group`, and a deleted group leaves an
 * inert mapping rather than a silent cascade.
 */
export const groupRoleMapping = pgTable(
  'group_role_mapping',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    localGroupId: text('local_group_id').references(() => localGroup.id, { onDelete: 'cascade' }),
    identityConnectionId: text('identity_connection_id').references(() => identityConnection.id, {
      onDelete: 'cascade',
    }),
    scimGroupId: text('scim_group_id'),
    role: text('role').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'group_role_mapping_one_target',
      sql`(${table.localGroupId} is not null and ${table.identityConnectionId} is null and ${table.scimGroupId} is null) or (${table.localGroupId} is null and ${table.identityConnectionId} is not null and ${table.scimGroupId} is not null)`,
    ),
    unique('group_role_mapping_local_unique').on(table.orgId, table.localGroupId, table.role),
    unique('group_role_mapping_scim_unique').on(table.orgId, table.identityConnectionId, table.scimGroupId, table.role),
  ],
)

/**
 * Append-only audit log. `target_id`, `actor_id`, `connection_id` and `credential_id` have no
 * foreign keys, so history survives a purge. Never store secrets: credential ids, not values.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id),
    occurredAt: timestamp('occurred_at').defaultNow().notNull(),
    action: text('action').notNull(),
    outcome: text('outcome', { enum: ['success', 'failure', 'denied'] }).notNull(),
    reason: text('reason'),
    actorType: text('actor_type', { enum: ['user', 'scim_connection', 'system'] }).notNull(),
    actorId: text('actor_id'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    connectionId: text('connection_id'),
    credentialId: text('credential_id'),
    requestId: text('request_id'),
    reportSource: text('report_source', { enum: ['server', 'client'] })
      .default('server')
      .notNull(),
    changes: jsonb('changes'),
    metadata: jsonb('metadata'),
    // Filled for sign-in events only.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('audit_event_occurred_idx').on(table.orgId, table.occurredAt, table.id),
    index('audit_event_action_idx').on(table.orgId, table.action, table.occurredAt),
    index('audit_event_target_idx').on(table.orgId, table.targetType, table.targetId),
    index('audit_event_actor_idx').on(table.orgId, table.actorId),
    index('audit_event_connection_idx').on(table.orgId, table.connectionId, table.occurredAt),
  ],
)
