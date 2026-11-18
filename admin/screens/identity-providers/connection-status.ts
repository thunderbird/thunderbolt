/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminConnection } from '@shared/admin-api'

export type ScimState = 'active' | 'retiring' | 'retired'

export type ConnectionSummary = {
  sso: AdminConnection['sso']
  scim: ScimState | null
  /** Out of service: retired outright, or a SCIM-only connection whose SCIM side is retired. */
  retired: boolean
  /** Rename and the SSO settings: an admin-created, live SSO side. A SCIM-only connection can't be renamed. */
  canEditSso: boolean
  /** The backend refuses while a SCIM side is active or still retiring. */
  canRetireSso: boolean
  canAddSso: boolean
  canAddScim: boolean
}

const scimState = ({ scim, status }: Pick<AdminConnection, 'scim' | 'status'>): ScimState | null => {
  if (!scim) {
    return null
  }
  if (status === 'scim_retiring') {
    return 'retiring'
  }
  return status === 'active' ? 'active' : 'retired'
}

/**
 * What a connection's two sides are doing and which actions the screen offers for it. The env
 * connection's SSO side belongs to the server's settings, but it can still take a SCIM side.
 */
export const describeConnection = (connection: Pick<AdminConnection, 'sso' | 'scim' | 'status'>): ConnectionSummary => {
  const { sso, status } = connection
  const scim = scimState(connection)
  const retired = status === 'retired' || (!sso && scim === 'retired')
  const ownSso = sso !== null && !sso.envOwned && !retired
  return {
    sso,
    scim,
    retired,
    canEditSso: ownSso,
    canRetireSso: ownSso && (scim === null || scim === 'retired'),
    canAddSso: !sso && status === 'active',
    canAddScim: !connection.scim && status === 'active',
  }
}
