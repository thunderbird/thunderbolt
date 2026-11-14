/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Every audit action the backend records. The outcome (`success`, `failure`, `denied`) is its own
 * column, so an action has no failed variant. Adding an action is a code change, not a migration.
 */
export const auditActions = [
  // Authentication and sessions
  'auth.sign_in',
  'auth.sign_out',
  'auth.session_revoked',
  'auth.session_expired',
  'account.deleted',
  // Members
  'member.admitted',
  'member.source_added',
  'member.source_suspended',
  'member.source_removed',
  'member.blocked',
  'member.unblocked',
  'member.role_granted',
  'member.role_revoked',
  'member.bootstrap_admin_granted',
  'member.purged',
  // Linking
  'link.created',
  'link.detached',
  'link_review.created',
  'link_review.approved',
  'link_review.rejected',
  // Invitations and domains
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'invitation.override_used',
  'domain.added',
  'domain.verified',
  'domain.removed',
  'domain.claimed',
  'domain.unclaimed',
  // Groups and role mappings
  'local_group.created',
  'local_group.updated',
  'local_group.deleted',
  'local_group.member_added',
  'local_group.member_removed',
  'group_role_mapping.created',
  'group_role_mapping.deleted',
  // Connections and configuration
  'connection.created',
  'connection.updated',
  'connection.retiring',
  'connection.retired',
  'scim_credential.issued',
  'scim_credential.rotated',
  'scim_credential.revoked',
  'admission_policy.updated',
  // Provisioning, attributed to the SCIM connection
  'scim.user_created',
  'scim.user_updated',
  'scim.user_deactivated',
  'scim.user_reactivated',
  'scim.user_deleted',
  'scim.group_created',
  'scim.group_updated',
  'scim.group_deleted',
  'scim.group_members_changed',
  'scim.request',
  // A user's own connections; changes that happen only on the device are client-reported
  'user_connection.added',
  'user_connection.updated',
  'user_connection.removed',
  'user_connection.credential_replaced',
  // Audit administration
  'audit.read_bulk',
  'audit.exported',
  'admin.access_denied',
] as const

export type AuditAction = (typeof auditActions)[number]

export type AuditOutcome = 'success' | 'failure' | 'denied'

export type AuditActorType = 'user' | 'scim_connection' | 'api_key' | 'system'
