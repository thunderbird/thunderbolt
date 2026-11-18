/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminMember } from '@shared/admin-api'

/** A member for tests: a local member with access, no roles and no IdP. */
export const makeMember = (overrides: Partial<AdminMember> = {}): AdminMember => ({
  userId: 'user-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  joinedAt: '2026-11-01T00:00:00.000Z',
  access: { allowed: true },
  blocked: null,
  sources: [{ kind: 'open', status: 'active', connection: null }],
  roles: [],
  groups: [],
  idpManaged: null,
  requiresSso: false,
  ...overrides,
})

export const okta = { id: 'conn-1', name: 'Okta' }

/** A member Okta manages over SCIM, with the link in `status`. */
export const makeScimMember = (
  status: AdminMember['sources'][number]['status'],
  overrides: Partial<AdminMember> = {},
) =>
  makeMember({
    sources: [
      { kind: 'open', status: 'active', connection: null },
      { kind: 'scim', status, connection: okta },
    ],
    idpManaged: { connections: [okta], fields: ['email', 'name', 'scimGroups', 'scimRoles', 'status'] },
    ...overrides,
  })
