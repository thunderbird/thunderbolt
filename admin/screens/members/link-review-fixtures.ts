/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { LinkReview } from '@shared/admin-api'

/** A pending SSO review, for tests. */
export const linkReview = (overrides: Partial<LinkReview> = {}): LinkReview => ({
  id: crypto.randomUUID(),
  orgId: 'org',
  identityConnectionId: 'c1',
  trigger: 'sso_sign_in',
  externalId: 'sub-1',
  incomingEmail: 'ada@example.com',
  incomingName: 'Ada Lovelace',
  candidateUserId: 'u1',
  status: 'pending',
  resolvedBy: null,
  resolvedAt: null,
  attempts: 1,
  lastSeenAt: '2026-11-17T10:00:00.000Z',
  createdAt: '2026-11-17T09:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  candidate: { id: 'u1', email: 'ada.l@example.com', name: 'Ada L.' },
  connection: { id: 'c1', name: 'Okta' },
  ...overrides,
})
