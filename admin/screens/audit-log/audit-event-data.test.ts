/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { auditApiKeyId, auditDataEntries, auditFieldChanges, formatAuditValue } from './audit-event-data'
import { auditItemLink } from './audit-item-link'

describe('auditApiKeyId', () => {
  it('reads the key id from the metadata, and is null without one', () => {
    expect(auditApiKeyId({ apiKeyId: 'key-1', method: 'GET' })).toBe('key-1')
    expect(auditApiKeyId({ method: 'GET' })).toBeNull()
    expect(auditApiKeyId({ apiKeyId: 7 })).toBeNull()
    expect(auditApiKeyId(null)).toBeNull()
    expect(auditApiKeyId(['key-1'])).toBeNull()
  })
})

describe('auditFieldChanges', () => {
  it('reads the { field: { from, to } } shape, field by field', () => {
    expect(auditFieldChanges({ status: { from: 'pending', to: 'approved' } })).toEqual([
      { field: 'status', from: 'pending', to: 'approved' },
    ])
  })

  it('is null for any other shape, so the panel shows it raw', () => {
    expect(auditFieldChanges(null)).toBeNull()
    expect(auditFieldChanges({})).toBeNull()
    expect(auditFieldChanges(['a'])).toBeNull()
    expect(auditFieldChanges({ status: 'approved' })).toBeNull()
    expect(auditFieldChanges({ status: { to: 'approved' } })).toBeNull()
  })
})

describe('auditDataEntries', () => {
  it("lists an object's keys, and is null for a list, a scalar or an empty object", () => {
    expect(auditDataEntries({ kind: 'sso', tier: 1 })).toEqual([
      ['kind', 'sso'],
      ['tier', 1],
    ])
    expect(auditDataEntries(['a'])).toBeNull()
    expect(auditDataEntries('a')).toBeNull()
    expect(auditDataEntries({})).toBeNull()
  })
})

describe('formatAuditValue', () => {
  it('shows a string as it is and anything else as JSON', () => {
    expect(formatAuditValue('okta')).toBe('okta')
    expect(formatAuditValue(false)).toBe('false')
    expect(formatAuditValue(null)).toBe('null')
    expect(formatAuditValue(undefined)).toBe('null')
    expect(formatAuditValue(['admin'])).toBe('["admin"]')
  })
})

describe('auditItemLink', () => {
  it('opens members, groups, connections and domains on their own screens', () => {
    expect(auditItemLink('user', 'u1')).toEqual({ to: '/admin/members', state: { adminOpenItem: 'u1' } })
    expect(auditItemLink('local_group', 'g1')).toEqual({ to: '/admin/groups', state: { adminOpenItem: 'g1' } })
    expect(auditItemLink('scim_connection', 'c1')?.state).toEqual({ adminOpenItem: 'connection:c1' })
    expect(auditItemLink('identity_connection', 'c1')?.state).toEqual({ adminOpenItem: 'connection:c1' })
    expect(auditItemLink('org_domain', 'd1')).toEqual({
      to: '/admin/sign-in-methods',
      state: { adminOpenItem: 'domain:d1' },
    })
  })

  it('is null for a type with no screen of its own', () => {
    expect(auditItemLink('api_key', 'k1')).toBeNull()
    expect(auditItemLink('toString', 'x')).toBeNull()
  })
})
