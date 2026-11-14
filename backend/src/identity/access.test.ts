/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { identityConnectionStatuses } from '@/db/schema'
import { describe, expect, it } from 'bun:test'
import { type AccessState, computeAccess, isIdpManaged, type MembershipSourceRow, requiresSso } from './access'

const membership = { id: 'm1', orgId: 'default', userId: 'u1', blockedAt: null }

const source = (overrides: Partial<MembershipSourceRow>): MembershipSourceRow => ({
  id: crypto.randomUUID(),
  kind: 'local',
  status: 'active',
  identityConnectionId: null,
  ref: null,
  ...overrides,
})

const state = (
  sources: MembershipSourceRow[],
  overrides: Partial<AccessState> = {},
  connectionStatusById: AccessState['connectionStatusById'] = new Map([
    ['entra', 'active'],
    ['keycloak', 'active'],
  ]),
): AccessState => ({ membership, sources, connectionStatusById, ssoConnectionIds: new Set(), ...overrides })

describe('computeAccess', () => {
  it('refuses a user with no membership', () => {
    expect(computeAccess(state([], { membership: null }))).toEqual({ allowed: false, reason: 'not_member' })
  })

  it('admits a member with an active local source', () => {
    expect(computeAccess(state([source({ kind: 'waitlist' })]))).toEqual({ allowed: true })
  })

  it('refuses a blocked member even while an IdP keeps them active', () => {
    const blocked = state([source({ kind: 'scim', identityConnectionId: 'entra' })], {
      membership: { ...membership, blockedAt: new Date() },
    })
    expect(computeAccess(blocked)).toEqual({ allowed: false, reason: 'blocked' })
  })

  it('refuses a member whose IdP deprovisioned them, whatever local grants they hold', () => {
    const sources = [
      source({ kind: 'scim', identityConnectionId: 'entra', status: 'suspended' }),
      source({ kind: 'invitation' }),
      source({ kind: 'domain' }),
      source({ kind: 'bootstrap' }),
    ]
    expect(computeAccess(state(sources))).toEqual({ allowed: false, reason: 'deprovisioned' })
    expect(computeAccess(state([source({ kind: 'scim', identityConnectionId: 'entra', status: 'removed' })]))).toEqual({
      allowed: false,
      reason: 'deprovisioned',
    })
  })

  it('keeps a member in while any one of their IdPs is active', () => {
    const sources = [
      source({ kind: 'scim', identityConnectionId: 'keycloak', status: 'suspended' }),
      source({ kind: 'scim', identityConnectionId: 'entra' }),
    ]
    expect(computeAccess(state(sources))).toEqual({ allowed: true })
  })

  it('refuses a member with no live source', () => {
    const sources = [source({ kind: 'invitation', status: 'removed' }), source({ kind: 'sso', status: 'suspended' })]
    expect(computeAccess(state(sources))).toEqual({ allowed: false, reason: 'no_live_source' })
  })

  it('ignores the sources of a connection whose SCIM side is retired', () => {
    const retired = new Map([['entra', 'scim_retired' as const]])
    expect(
      computeAccess(
        state(
          [source({ kind: 'scim', identityConnectionId: 'entra', status: 'suspended' }), source({ kind: 'local' })],
          {},
          retired,
        ),
      ),
    ).toEqual({ allowed: true })
    expect(computeAccess(state([source({ kind: 'scim', identityConnectionId: 'entra' })], {}, retired))).toEqual({
      allowed: false,
      reason: 'no_live_source',
    })
  })

  it('ignores the SSO sources of a retired connection, so only another live source keeps the member in', () => {
    const okta = (status: (typeof identityConnectionStatuses)[number]) => new Map([['okta', status]])
    const ssoSource = source({ kind: 'sso', identityConnectionId: 'okta' })

    expect(computeAccess(state([ssoSource], {}, okta('retired')))).toEqual({ allowed: false, reason: 'no_live_source' })
    expect(computeAccess(state([ssoSource, source({ kind: 'invitation' })], {}, okta('retired')))).toEqual({
      allowed: true,
    })
    expect(computeAccess(state([ssoSource], {}, okta('active')))).toEqual({ allowed: true })
    expect(computeAccess(state([source({ kind: 'sso' })], {}, new Map()))).toEqual({ allowed: true })
  })
})

describe('isIdpManaged and requiresSso', () => {
  const entra = (status: MembershipSourceRow['status']) =>
    source({ kind: 'scim', identityConnectionId: 'entra', status })

  it('treats a member as IdP-managed through a counted SCIM source in any status', () => {
    for (const status of ['active', 'suspended', 'removed'] as const) {
      expect(isIdpManaged(state([entra(status)]))).toBe(true)
    }
    expect(isIdpManaged(state([source({ kind: 'invitation' })]))).toBe(false)
    expect(isIdpManaged(state([entra('active')], {}, new Map([['entra', 'scim_retired']])))).toBe(false)
  })

  it('requires SSO only when a managing connection has an SSO side', () => {
    expect(requiresSso(state([entra('active')]))).toBe(false)
    expect(requiresSso(state([entra('active')], { ssoConnectionIds: new Set(['entra']) }))).toBe(true)
    expect(
      requiresSso(
        state([entra('active')], { ssoConnectionIds: new Set(['entra']) }, new Map([['entra', 'scim_retiring']])),
      ),
    ).toBe(false)
  })
})
