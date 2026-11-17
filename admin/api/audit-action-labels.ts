/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { auditActions, type AuditAction } from '@shared/admin-api'

/** A label for every audit action. Keyed on the shared list, so a new backend action fails tsc until it has one. */
export const auditActionLabels: Record<AuditAction, MessageDescriptor> = {
  'auth.sign_in': msg`Signed in`,
  'auth.sign_out': msg`Signed out`,
  'auth.session_revoked': msg`Session revoked`,
  'auth.session_expired': msg`Session expired`,
  'account.deleted': msg`Account deleted`,
  'member.admitted': msg`Member admitted`,
  'member.source_added': msg`Membership source added`,
  'member.source_suspended': msg`Membership source suspended`,
  'member.source_removed': msg`Membership source removed`,
  'member.blocked': msg`Member blocked`,
  'member.unblocked': msg`Member unblocked`,
  'member.updated': msg`Member updated`,
  'member.role_granted': msg`Role granted`,
  'member.role_revoked': msg`Role revoked`,
  'member.bootstrap_admin_granted': msg`Bootstrap admin granted`,
  'member.purged': msg`Member permanently deleted`,
  'link.created': msg`Identity provider link created`,
  'link.detached': msg`Identity provider link detached`,
  'link_review.created': msg`Link review opened`,
  'link_review.approved': msg`Link review approved`,
  'link_review.rejected': msg`Link review rejected`,
  'invitation.created': msg`Invitation sent`,
  'invitation.accepted': msg`Invitation accepted`,
  'invitation.revoked': msg`Invitation revoked`,
  'invitation.override_used': msg`Identity provider override used`,
  'domain.added': msg`Domain added`,
  'domain.verified': msg`Domain verified`,
  'domain.removed': msg`Domain removed`,
  'domain.claimed': msg`Domain claimed`,
  'domain.unclaimed': msg`Domain released`,
  'local_group.created': msg`Group created`,
  'local_group.updated': msg`Group updated`,
  'local_group.deleted': msg`Group deleted`,
  'local_group.member_added': msg`Group member added`,
  'local_group.member_removed': msg`Group member removed`,
  'group_role_mapping.created': msg`Group role mapping added`,
  'group_role_mapping.deleted': msg`Group role mapping removed`,
  'connection.created': msg`Connection created`,
  'connection.updated': msg`Connection updated`,
  'connection.retiring': msg`Connection retiring`,
  'connection.retired': msg`Connection retired`,
  'scim_credential.issued': msg`SCIM credential issued`,
  'scim_credential.rotated': msg`SCIM credential rotated`,
  'scim_credential.revoked': msg`SCIM credential revoked`,
  'admission_policy.updated': msg`Admission policy updated`,
  'scim.user_created': msg`SCIM user created`,
  'scim.user_updated': msg`SCIM user updated`,
  'scim.user_deactivated': msg`SCIM user deactivated`,
  'scim.user_reactivated': msg`SCIM user reactivated`,
  'scim.user_deleted': msg`SCIM user deleted`,
  'scim.group_created': msg`SCIM group created`,
  'scim.group_updated': msg`SCIM group updated`,
  'scim.group_deleted': msg`SCIM group deleted`,
  'scim.group_members_changed': msg`SCIM group members changed`,
  'scim.request': msg`SCIM request`,
  'user_connection.added': msg`Personal connection added`,
  'user_connection.updated': msg`Personal connection updated`,
  'user_connection.removed': msg`Personal connection removed`,
  'user_connection.credential_replaced': msg`Personal connection credential replaced`,
  'audit.read_bulk': msg`Audit log read in bulk`,
  'audit.exported': msg`Audit log exported`,
  'admin.access_denied': msg`Admin access denied`,
}

const isAuditAction = (action: string): action is AuditAction => (auditActions as readonly string[]).includes(action)

/** The label for an action, or null for one this build doesn't know (show the raw id then). */
export const getAuditActionLabel = (action: string): MessageDescriptor | null =>
  isAuditAction(action) ? auditActionLabels[action] : null

/**
 * Labels for the target types the backend records. The column is free text, so this covers the
 * known ones and `getAuditTargetLabel` returns null for the rest (show the raw type then).
 */
const auditTargetLabels = {
  user: msg`Person`,
  device: msg`Device`,
  invitation: msg`Invitation`,
  link_review: msg`Link review`,
  local_group: msg`Group`,
  group_role_mapping: msg`Group role mapping`,
  identity_connection: msg`Identity provider`,
  org_domain: msg`Domain`,
  organization: msg`Organization`,
  scim_credential: msg`SCIM credential`,
  scim_group: msg`SCIM group`,
  scim_user: msg`SCIM user`,
  mcp_server: msg`MCP server`,
} satisfies Record<string, MessageDescriptor>

/** The label for a target type, or null for one this build doesn't know. */
export const getAuditTargetLabel = (targetType: string): MessageDescriptor | null =>
  Object.hasOwn(auditTargetLabels, targetType) ? auditTargetLabels[targetType as keyof typeof auditTargetLabels] : null
