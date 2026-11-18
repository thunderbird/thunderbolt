/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { auditLogPath, parseAuditLogSearch } from './audit-log-url'

describe('audit log URL', () => {
  it('links to the unfiltered log', () => {
    expect(auditLogPath()).toBe('/admin/audit-log')
  })

  it('round-trips every filter and leaves paging out', () => {
    const filters = {
      action: 'scim.request',
      outcome: 'failure' as const,
      actorId: 'u1',
      targetType: 'user',
      targetId: 'u2',
      connectionId: 'c1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-17T23:59:59.999Z',
    }
    const path = auditLogPath({ ...filters, cursor: 'next', limit: 10 })
    expect(path).not.toContain('cursor')
    expect(parseAuditLogSearch(new URL(path, 'http://app.test').search)).toEqual(filters)
  })

  it('drops an unknown outcome and empty values', () => {
    expect(parseAuditLogSearch('?outcome=maybe&action=&connectionId=c1')).toEqual({ connectionId: 'c1' })
  })
})
