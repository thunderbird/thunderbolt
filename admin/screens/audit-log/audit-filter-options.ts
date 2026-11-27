/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type AuditAction, auditActions } from '@shared/admin-api'

const actionGroupLabels = {
  auth: msg`Sign-in and sessions`,
  members: msg`Members`,
  linking: msg`Linking`,
  admission: msg`Invitations and domains`,
  groups: msg`Groups and role mappings`,
  connections: msg`Connections`,
  provisioning: msg`Provisioning`,
  personal: msg`Personal connections`,
  administration: msg`Administration`,
} satisfies Record<string, MessageDescriptor>

type ActionGroupId = keyof typeof actionGroupLabels

/** How the action filter groups actions, by the part of the id before the dot. */
const actionGroupByPrefix: Record<string, ActionGroupId> = {
  auth: 'auth',
  account: 'auth',
  member: 'members',
  link: 'linking',
  link_review: 'linking',
  invitation: 'admission',
  domain: 'admission',
  local_group: 'groups',
  group_role_mapping: 'groups',
  connection: 'connections',
  scim_credential: 'connections',
  admission_policy: 'connections',
  scim: 'provisioning',
  user_connection: 'personal',
  audit: 'administration',
  admin: 'administration',
}

export type AuditActionGroup = { id: ActionGroupId; label: MessageDescriptor; actions: AuditAction[] }

/** Every audit action, grouped for the action filter, in `auditActions` order. */
export const auditActionGroups: AuditActionGroup[] = Object.entries(actionGroupLabels).map(([id, label]) => ({
  id: id as ActionGroupId,
  label,
  actions: auditActions.filter((action) => actionGroupByPrefix[action.slice(0, action.indexOf('.'))] === id),
}))

/** The target types the target filter offers; each is labelled through `getAuditTargetLabel`. */
export const auditTargetTypes = [
  'user',
  'invitation',
  'link_review',
  'local_group',
  'group_role_mapping',
  'identity_connection',
  'scim_credential',
  'scim_group',
  'org_domain',
  'organization',
] as const
