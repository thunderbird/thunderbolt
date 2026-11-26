/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AuditEventQuery, ListInvitationsQuery, ListLinkReviewsQuery, RoleMappingQuery } from '@shared/admin-api'

/**
 * TanStack Query keys for every admin read. All of them start with `['admin']`, so one
 * `invalidateQueries({ queryKey: adminQueryKeys.all })` refreshes or clears the lot.
 */
export const adminQueryKeys = {
  all: ['admin'] as const,
  members: {
    all: ['admin', 'members'] as const,
    list: (q?: string) => ['admin', 'members', 'list', { q }] as const,
    detail: (userId: string) => ['admin', 'members', 'detail', userId] as const,
  },
  groups: {
    all: ['admin', 'groups'] as const,
    list: () => ['admin', 'groups', 'list'] as const,
    detail: (groupId: string) => ['admin', 'groups', 'detail', groupId] as const,
    members: (groupId: string) => ['admin', 'groups', 'members', groupId] as const,
  },
  invitations: {
    all: ['admin', 'invitations'] as const,
    list: (query: ListInvitationsQuery) => ['admin', 'invitations', 'list', query] as const,
  },
  connections: {
    all: ['admin', 'connections'] as const,
    list: () => ['admin', 'connections', 'list'] as const,
    detail: (connectionId: string) => ['admin', 'connections', 'detail', connectionId] as const,
    scimGroups: (connectionId: string) => ['admin', 'connections', 'scim-groups', connectionId] as const,
  },
  roleMappings: {
    all: ['admin', 'role-mappings'] as const,
    list: (query: RoleMappingQuery) => ['admin', 'role-mappings', 'list', query] as const,
  },
  domains: {
    all: ['admin', 'domains'] as const,
    list: () => ['admin', 'domains', 'list'] as const,
  },
  linkReviews: {
    all: ['admin', 'link-reviews'] as const,
    list: (query: ListLinkReviewsQuery) => ['admin', 'link-reviews', 'list', query] as const,
  },
  auditEvents: {
    all: ['admin', 'audit-events'] as const,
    lists: ['admin', 'audit-events', 'list'] as const,
    list: (query: AuditEventQuery) => ['admin', 'audit-events', 'list', query] as const,
    detail: (eventId: string) => ['admin', 'audit-events', 'detail', eventId] as const,
  },
  breakGlass: ['admin', 'break-glass'] as const,
}
