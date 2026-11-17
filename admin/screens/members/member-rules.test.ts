/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { i18n } from '@lingui/core'
import { describe, expect, it } from 'bun:test'
import { makeMember, makeScimMember, okta } from './member-fixtures'
import {
  getBlockState,
  getDetachState,
  getPurgeState,
  getRenameState,
  getRevokeAdminState,
  isAdmin,
  isSelfDemotingGroupRemoval,
  type Availability,
  type ConnectionStatusById,
} from './member-rules'

/** The refusal's English text, or null when the action can go through. */
const reasonOf = (state: Availability | null) => (state && !state.available ? i18n._(state.reason) : null)

const active: ConnectionStatusById = new Map([[okta.id, 'active']])
const retired: ConnectionStatusById = new Map([[okta.id, 'scim_retired']])

describe('getRenameState', () => {
  it('allows renaming a local member', () => {
    expect(getRenameState(makeMember())).toEqual({ available: true })
  })

  it('refuses while an IdP manages the name', () => {
    expect(getRenameState(makeScimMember('active')).available).toBe(false)
  })
})

describe('getBlockState', () => {
  it('refuses blocking yourself', () => {
    expect(reasonOf(getBlockState(makeMember(), 'user-1'))).toBe("You can't block yourself.")
  })

  it('allows blocking someone else, even when an IdP manages them', () => {
    expect(getBlockState(makeScimMember('active'), 'admin-1')).toEqual({ available: true })
  })
})

describe('getRevokeAdminState', () => {
  it('revokes a local or bootstrap grant without a confirm', () => {
    for (const from of ['local', 'bootstrap'] as const) {
      const member = makeMember({ roles: [{ role: 'admin', from }] })
      expect(isAdmin(member)).toBe(true)
      expect(getRevokeAdminState(member, 'admin-1')).toEqual({ available: true, confirmSelfDemotion: false })
    }
  })

  it('has nothing to revoke when admin comes only from a local or SCIM group', () => {
    const fromLocal = makeMember({ roles: [{ role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' }] })
    const fromScim = makeMember({
      roles: [{ role: 'admin', from: 'scim', groupId: 's1', groupName: 'Admins', connectionId: okta.id }],
    })
    expect(getRevokeAdminState(fromLocal, 'admin-1').available).toBe(false)
    expect(getRevokeAdminState(fromScim, 'admin-1').available).toBe(false)
  })

  it('needs the self-demotion confirm when your own grant is your only admin source', () => {
    const self = makeMember({ userId: 'admin-1', roles: [{ role: 'admin', from: 'local' }] })
    expect(getRevokeAdminState(self, 'admin-1')).toEqual({ available: true, confirmSelfDemotion: true })
  })

  it('needs no confirm on your own grant while a group keeps you admin', () => {
    const self = makeMember({
      userId: 'admin-1',
      roles: [
        { role: 'admin', from: 'local' },
        { role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' },
      ],
    })
    expect(getRevokeAdminState(self, 'admin-1')).toEqual({ available: true, confirmSelfDemotion: false })
  })
})

describe('getDetachState', () => {
  const scimSource = (member: ReturnType<typeof makeScimMember>) => member.sources[1]

  it('is not offered on a non-SCIM source', () => {
    const member = makeScimMember('removed')
    expect(getDetachState(member.sources[0], member, 'admin-1', active)).toBeNull()
  })

  it('allows detaching a link the IdP deleted', () => {
    const member = makeScimMember('removed')
    expect(getDetachState(scimSource(member), member, 'admin-1', active)).toEqual({ available: true })
  })

  it('refuses an active or suspended link on an active connection', () => {
    for (const status of ['active', 'suspended'] as const) {
      const member = makeScimMember(status)
      expect(getDetachState(scimSource(member), member, 'admin-1', active)?.available).toBe(false)
    }
  })

  it('treats an unknown connection status as active', () => {
    const member = makeScimMember('active')
    expect(getDetachState(scimSource(member), member, 'admin-1', new Map())?.available).toBe(false)
  })

  it('allows detaching any link on a retired SCIM side', () => {
    const member = makeScimMember('active')
    expect(getDetachState(scimSource(member), member, 'admin-1', retired)).toEqual({ available: true })
  })

  it('refuses detaching your own link', () => {
    const member = makeScimMember('removed', { userId: 'admin-1' })
    expect(reasonOf(getDetachState(scimSource(member), member, 'admin-1', active))).toBe(
      "You can't detach your own link.",
    )
  })
})

describe('getPurgeState', () => {
  it('is not offered while the member has access', () => {
    expect(getPurgeState(makeMember(), active)).toBeNull()
  })

  it('is available for a blocked member or one the IdP deleted', () => {
    const blocked = makeMember({
      access: { allowed: false, reason: 'blocked' },
      blocked: { at: '2026-11-02T00:00:00.000Z', by: 'admin-1', reason: null },
    })
    const deprovisioned = makeScimMember('removed', { access: { allowed: false, reason: 'deprovisioned' } })
    expect(getPurgeState(blocked, active)).toEqual({ available: true })
    expect(getPurgeState(deprovisioned, active)).toEqual({ available: true })
  })

  it('refuses while the IdP has only suspended the member', () => {
    const suspended = makeScimMember('suspended', { access: { allowed: false, reason: 'deprovisioned' } })
    expect(getPurgeState(suspended, active)?.available).toBe(false)
    expect(getPurgeState(suspended, retired)).toEqual({ available: true })
  })
})

describe('isSelfDemotingGroupRemoval', () => {
  const fromGroup = { role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' } as const

  it('is true when the group is your only admin source', () => {
    expect(isSelfDemotingGroupRemoval(makeMember({ roles: [fromGroup] }), 'g1')).toBe(true)
  })

  it('is false when another group or a grant keeps you admin', () => {
    const otherGroup = { ...fromGroup, groupId: 'g2', groupName: 'Leads' }
    expect(isSelfDemotingGroupRemoval(makeMember({ roles: [fromGroup, otherGroup] }), 'g1')).toBe(false)
    expect(isSelfDemotingGroupRemoval(makeMember({ roles: [fromGroup, { role: 'admin', from: 'local' }] }), 'g1')).toBe(
      false,
    )
  })

  it('is false when the group gives you no admin role', () => {
    expect(isSelfDemotingGroupRemoval(makeMember({ roles: [{ role: 'admin', from: 'local' }] }), 'g1')).toBe(false)
    expect(isSelfDemotingGroupRemoval(makeMember(), 'g1')).toBe(false)
  })
})
