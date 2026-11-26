/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { adminRole, type AdminMember } from '@shared/admin-api'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { makeMember } from './member-fixtures'
import { useMemberFormState } from './use-member-form-state'

const ops = { id: 'g1', name: 'Ops' }
const design = { id: 'g2', name: 'Design' }

/** A backend with no other groups, answering every change with an empty body. */
const respond = ({ method, path }: FakeRequest): FakeReply =>
  method === 'GET' && path === 'admin/groups' ? { body: { items: [], nextCursor: null } } : { body: {} }

/** The form for `member`, edited by the test session's admin, admin-1. */
const renderForm = (member: AdminMember) => {
  const harness = createAdminTestHarness(respond)
  const rendered = renderHook(
    () => useMemberFormState(member, 'admin-1', { onDirtyChange: () => {}, onSaved: () => {} }),
    { wrapper: harness.wrapper },
  )
  return { harness, ...rendered }
}

const changes = (requests: FakeRequest[]) => requests.filter((request) => request.method !== 'GET')

describe('useMemberFormState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('leaves the group that makes an admin editing themselves an admin after the group that does not', async () => {
    const self = makeMember({
      userId: 'admin-1',
      groups: [ops, design],
      roles: [{ role: adminRole, from: 'local_group', groupId: 'g1', groupName: 'Ops' }],
    })
    const { harness, result } = renderForm(self)
    await flush()

    act(() => result.current.setGroupIds([]))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'DELETE', path: 'admin/groups/g2/members/admin-1' },
      { method: 'DELETE', path: 'admin/groups/g1/members/admin-1' },
    ])
  })

  it('revokes the own grant before leaving the group that makes an admin editing themselves an admin', async () => {
    const self = makeMember({
      userId: 'admin-1',
      groups: [ops],
      roles: [
        { role: adminRole, from: 'local' },
        { role: adminRole, from: 'local_group', groupId: 'g1', groupName: 'Ops' },
      ],
    })
    const { harness, result } = renderForm(self)
    await flush()

    act(() => result.current.setIsAdmin(false))
    act(() => result.current.setGroupIds([]))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'DELETE', path: 'admin/members/admin-1/roles/admin' },
      { method: 'DELETE', path: 'admin/groups/g1/members/admin-1' },
    ])
  })
})
