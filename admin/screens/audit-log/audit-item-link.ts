/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { adminItemLink } from '../../components/use-resource-page-state'
import { connectionEditId, domainEditId } from '../sign-in-methods/sign-in-method-ids'

const itemLinks: Record<string, (id: string) => ReturnType<typeof adminItemLink>> = {
  user: (id) => adminItemLink('/admin/members', id),
  local_group: (id) => adminItemLink('/admin/groups', id),
  identity_connection: (id) => adminItemLink('/admin/sign-in-methods', connectionEditId(id)),
  // SCIM events name the identity connection as their actor.
  scim_connection: (id) => adminItemLink('/admin/sign-in-methods', connectionEditId(id)),
  org_domain: (id) => adminItemLink('/admin/sign-in-methods', domainEditId(id)),
}

/**
 * A link that opens an audit event's actor or target on its own admin screen: a member, group,
 * connection or domain. Null for a type with no screen of its own.
 */
export const auditItemLink = (type: string, id: string) => (Object.hasOwn(itemLinks, type) ? itemLinks[type](id) : null)
