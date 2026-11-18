/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { auditActions } from '@shared/admin-api'
import { describe, expect, it } from 'bun:test'
import { getAuditTargetLabel } from '../../api/audit-action-labels'
import { auditActionGroups, auditTargetTypes } from './audit-filter-options'

describe('audit filter options', () => {
  it('puts every action in exactly one labelled group', () => {
    expect(auditActionGroups.every((group) => group.actions.length > 0)).toBe(true)
    expect(auditActionGroups.flatMap((group) => group.actions).toSorted()).toEqual([...auditActions].toSorted())
  })

  it('offers only target types that have a label', () => {
    expect(auditTargetTypes.filter((type) => !getAuditTargetLabel(type))).toEqual([])
  })
})
