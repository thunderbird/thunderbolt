/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { auditActions } from '@shared/admin-api'
import { describe, expect, it } from 'bun:test'
import { auditActionLabels, getAuditActionLabel, getAuditTargetLabel } from './audit-action-labels'

describe('getAuditActionLabel', () => {
  it('labels every action the backend records', () => {
    for (const action of auditActions) {
      expect(getAuditActionLabel(action)).toBe(auditActionLabels[action])
    }
  })

  it('has no label for an action this build does not know', () => {
    expect(getAuditActionLabel('future.action')).toBeNull()
  })
})

describe('getAuditTargetLabel', () => {
  it('labels a known target type and has none for an unknown one', () => {
    expect(getAuditTargetLabel('identity_connection')).not.toBeNull()
    expect(getAuditTargetLabel('future_thing')).toBeNull()
    expect(getAuditTargetLabel('toString')).toBeNull()
  })
})
