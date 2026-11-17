/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { i18n } from '@lingui/core'
import { describe, expect, it } from 'bun:test'
import { domainCheckErrorMessages } from '../../api/error-messages'
import {
  claimableConnections,
  getConnectionKindLabel,
  getDomainCheckErrorMessage,
  getDomainStatus,
  getEnrollmentLock,
} from './domain-rules'
import { makeConnection, makeDomain } from './fixtures'

const verified = { verifiedAt: '2026-11-17T01:00:00.000Z' }
const claimed = { ...verified, claimedBy: { id: 'c1', name: 'Okta' } }

describe('getDomainStatus', () => {
  it('reads unverified, verified and claimed', () => {
    expect(getDomainStatus(makeDomain())).toBe('unverified')
    expect(getDomainStatus(makeDomain(verified))).toBe('verified')
    expect(getDomainStatus(makeDomain(claimed))).toBe('claimed')
  })
})

describe('getEnrollmentLock', () => {
  it('locks an unverified domain, then a claimed one, and frees a verified unclaimed one', () => {
    expect(getEnrollmentLock(makeDomain())).toBe('unverified')
    expect(getEnrollmentLock(makeDomain(claimed))).toBe('claimed')
    expect(getEnrollmentLock(makeDomain(verified))).toBeNull()
  })
})

describe('getDomainCheckErrorMessage', () => {
  it('maps each known code and returns null for an unknown one', () => {
    expect(getDomainCheckErrorMessage('TXT_RECORD_MISMATCH')).toBe(domainCheckErrorMessages.TXT_RECORD_MISMATCH)
    expect(getDomainCheckErrorMessage('SOMETHING_NEW')).toBeNull()
    expect(getDomainCheckErrorMessage('toString')).toBeNull()
  })
})

describe('claimableConnections', () => {
  it('drops only retired connections', () => {
    const statuses = ['active', 'scim_retiring', 'scim_retired', 'retired'] as const
    const connections = statuses.map((status) => makeConnection({ id: status, status }))
    expect(claimableConnections(connections).map((connection) => connection.id)).toEqual([
      'active',
      'scim_retiring',
      'scim_retired',
    ])
  })
})

describe('getConnectionKindLabel', () => {
  const scim = { scimConnectionId: 's1' }

  const label = (connection: Parameters<typeof getConnectionKindLabel>[0]) => {
    const descriptor = getConnectionKindLabel(connection)
    return descriptor && i18n._(descriptor)
  }

  it('labels SSO, SCIM and SSO + SCIM', () => {
    expect(label(makeConnection())).toBe('SSO')
    expect(label(makeConnection({ sso: null, scim }))).toBe('SCIM')
    expect(label(makeConnection({ scim }))).toBe('SSO + SCIM')
    expect(getConnectionKindLabel(makeConnection({ sso: null }))).toBeNull()
  })
})
