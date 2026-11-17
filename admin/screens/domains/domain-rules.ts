/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { AdminConnection, DomainCheckError, OrgDomain } from '@shared/admin-api'
import { domainCheckErrorMessages } from '../../api/error-messages'

export type DomainStatus = 'unverified' | 'verified' | 'claimed'

/** Where a domain stands: a claim implies a verified domain. */
export const getDomainStatus = (domain: OrgDomain): DomainStatus => {
  if (domain.claimedBy) {
    return 'claimed'
  }
  return domain.verifiedAt ? 'verified' : 'unverified'
}

/** Why the enrollment switch is locked, in the order the backend refuses it, or null when it isn't. */
export const getEnrollmentLock = (domain: OrgDomain): 'unverified' | 'claimed' | null => {
  if (!domain.verifiedAt) {
    return 'unverified'
  }
  return domain.claimedBy ? 'claimed' : null
}

/** The reason for a failed verification check, or null for a code this client doesn't know. */
export const getDomainCheckErrorMessage = (code: string): MessageDescriptor | null =>
  Object.hasOwn(domainCheckErrorMessages, code) ? domainCheckErrorMessages[code as DomainCheckError] : null

/** The connections that may claim a domain: every one that isn't retired, as the backend allows. */
export const claimableConnections = (connections: AdminConnection[]) =>
  connections.filter((connection) => connection.status !== 'retired')

const kindLabels = {
  both: msg`SSO + SCIM`,
  sso: msg`SSO`,
  scim: msg`SCIM`,
}

/** What a connection does, for the claim picker; null when it has neither SSO nor SCIM. */
export const getConnectionKindLabel = (connection: AdminConnection): MessageDescriptor | null => {
  if (connection.sso && connection.scim) {
    return kindLabels.both
  }
  if (connection.sso) {
    return kindLabels.sso
  }
  return connection.scim ? kindLabels.scim : null
}
