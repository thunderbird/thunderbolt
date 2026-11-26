/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AuditEvent } from '@shared/admin-api'

/** An audit event: an admin blocking member `u1`, unless `overrides` says otherwise. */
export const makeAuditEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: crypto.randomUUID(),
  orgId: 'org',
  occurredAt: '2026-11-17T10:00:00.000Z',
  action: 'member.blocked',
  outcome: 'success',
  reason: null,
  actorType: 'user',
  actorId: 'admin-1',
  targetType: 'user',
  targetId: 'u1',
  connectionId: null,
  credentialId: null,
  requestId: null,
  reportSource: 'server',
  changes: null,
  metadata: null,
  ipAddress: null,
  userAgent: null,
  actorLabel: null,
  targetLabel: null,
  ...overrides,
})
