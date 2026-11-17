/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminConnection, OrgDomain } from '@shared/admin-api'

/** Test rows for the domain screen. */
export const makeDomain = (overrides: Partial<OrgDomain> = {}): OrgDomain => ({
  id: 'd1',
  domain: 'example.com',
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheckError: null,
  enrollmentEnabled: false,
  claimedBy: null,
  record: { name: '_thunderbolt-verification.example.com', value: 'thunderbolt-verification=token' },
  createdAt: '2026-11-17T00:00:00.000Z',
  ...overrides,
})

export const makeConnection = (overrides: Partial<AdminConnection> = {}): AdminConnection => ({
  id: 'c1',
  name: 'Okta',
  status: 'active',
  matchClaim: 'email',
  sso: { providerId: 'okta', protocol: 'oidc', issuer: 'https://okta.test', envOwned: false },
  scim: null,
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  ...overrides,
})
