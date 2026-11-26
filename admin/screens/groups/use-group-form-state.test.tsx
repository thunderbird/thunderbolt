/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { adminRole, type RoleMapping } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { makeMember } from '../members/member-fixtures'
import { useMembersPageState } from '../members/use-members-page-state'
import { groupBackend } from './group-fixtures'
import { useGroupFormState } from './use-group-form-state'
import { useGroupPanelState } from './use-group-panel-state'

const adminMapping: RoleMapping = {
  id: 'm1',
  role: adminRole,
  target: { kind: 'local_group', groupId: 'g1', name: 'Ops' },
  createdAt: '2026-11-01T00:00:00.000Z',
}

/** `groupBackend`, with Ops mapped to the admin role. */
const adminGroupBackend = (removeReply?: FakeReply, self = makeMember({ userId: 'admin-1' })) => {
  const respond = groupBackend(removeReply, self)
  return (request: FakeRequest): FakeReply =>
    request.method === 'GET' && request.path === 'admin/role-mappings'
      ? { body: { items: [adminMapping] } }
      : respond(request)
}

const renderForm = (respond: (request: FakeRequest) => FakeReply, groupId: string | null = 'g1', onSaved = mock()) => {
  const harness = createAdminTestHarness(respond)
  const rendered = renderHook(
    () => {
      const panel = useGroupPanelState(groupId)
      return useGroupFormState(panel, { onDirtyChange: () => {}, onSaved })
    },
    { wrapper: harness.wrapper },
  )
  return { harness, onSaved, ...rendered }
}

const changes = (requests: FakeRequest[]) => requests.filter((request) => request.method !== 'GET')

describe('useGroupFormState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('offers only members who are not in the group yet', async () => {
    const { result } = renderForm(groupBackend())
    await flush()

    expect(result.current.candidates.map((member) => member.userId)).toEqual(['user-2'])
  })

  it('searches for members to add on the server', async () => {
    const { harness, result } = renderForm(groupBackend())
    await flush()

    act(() => result.current.setSearch(' bob '))
    await flush()

    expect(harness.requests.at(-1)).toMatchObject({ path: 'admin/members' })
    expect(harness.requests.at(-1)?.search.get('q')).toBe('bob')
  })

  it("doesn't share a cache entry with the Members page for the same search", async () => {
    const harness = createAdminTestHarness(groupBackend())
    const { result } = renderHook(
      () => ({
        form: useGroupFormState(useGroupPanelState('g1'), { onDirtyChange: () => {}, onSaved: () => {} }),
        page: useMembersPageState(),
      }),
      { wrapper: harness.wrapper },
    )
    await flush()

    const entries = harness.queryClient
      .getQueryCache()
      .findAll({ queryKey: adminQueryKeys.members.list(undefined) })
      .map((query) => query.queryKey)
    expect(entries).toHaveLength(2)
    expect(result.current.page.list.items).toHaveLength(2)
    expect(result.current.form.candidates).toHaveLength(1)
  })

  it('changes nothing until Save, then sends only what changed', async () => {
    const { harness, result, onSaved } = renderForm(groupBackend())
    await flush()

    act(() => result.current.setDescription('On call'))
    act(() => result.current.addMembers([{ userId: 'user-2', label: 'Bob' }]))
    act(() => result.current.removeMember('user-1'))
    await flush()
    expect(changes(harness.requests)).toEqual([])

    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'PATCH', path: 'admin/groups/g1', body: { description: 'On call' } },
      { method: 'POST', path: 'admin/groups/g1/members', body: { userId: 'user-2' } },
      { method: 'DELETE', path: 'admin/groups/g1/members/user-1' },
    ])
    expect(onSaved).toHaveBeenCalledWith({ groupId: 'g1', warning: false })
  })

  it('creates a group with its admin role and members', async () => {
    const { harness, result, onSaved } = renderForm(groupBackend(), null)
    await flush()
    expect(result.current.canSave).toBe(false)

    act(() => result.current.setName('Design'))
    act(() => result.current.setIsAdmin(true))
    act(() => result.current.addMembers([{ userId: 'user-2', label: 'Bob' }]))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'POST', path: 'admin/groups', body: { name: 'Design', description: '' } },
      { method: 'POST', path: 'admin/role-mappings', body: { localGroupId: 'g-new', role: adminRole } },
      { method: 'POST', path: 'admin/groups/g-new/members', body: { userId: 'user-2' } },
    ])
    expect(onSaved).toHaveBeenCalledWith({ groupId: 'g-new', warning: false })
  })

  it('removes the admin mapping and reports a break-glass warning', async () => {
    const { harness, result, onSaved } = renderForm(adminGroupBackend({ body: { warning: 'NO_LOCAL_ADMIN' } }))
    await flush()
    expect(result.current.draft.isAdmin).toBe(true)

    act(() => result.current.setIsAdmin(false))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([{ method: 'DELETE', path: 'admin/role-mappings/m1' }])
    expect(onSaved).toHaveBeenCalledWith({ groupId: 'g1', warning: true })
  })

  it('takes the admin role away only after the member changes', async () => {
    const { harness, result } = renderForm(adminGroupBackend())
    await flush()

    act(() => result.current.setIsAdmin(false))
    act(() => result.current.addMembers([{ userId: 'user-2', label: 'Bob' }]))
    act(() => result.current.removeMember('user-1'))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'POST', path: 'admin/groups/g1/members' },
      { method: 'DELETE', path: 'admin/groups/g1/members/user-1' },
      { method: 'DELETE', path: 'admin/role-mappings/m1' },
    ])
  })

  it('retries a create that failed halfway on the group it created, running only the unfinished steps', async () => {
    const respond = groupBackend()
    let failAdd = true
    const { harness, result, onSaved } = renderForm((request) => {
      if (failAdd && request.method === 'POST' && request.path === 'admin/groups/g-new/members') {
        failAdd = false
        return { status: 500, body: { error: 'INTERNAL' } }
      }
      return respond(request)
    }, null)
    await flush()

    act(() => result.current.setName('Design'))
    act(() => result.current.setIsAdmin(true))
    act(() => result.current.addMembers([{ userId: 'user-2', label: 'Bob' }]))
    act(() => result.current.save.mutate())
    await flush()
    expect(result.current.save.isError).toBe(true)
    expect(onSaved).not.toHaveBeenCalled()

    harness.requests.length = 0
    act(() => result.current.setName('Design team'))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'PATCH', path: 'admin/groups/g-new', body: { name: 'Design team' } },
      { method: 'POST', path: 'admin/groups/g-new/members', body: { userId: 'user-2' } },
    ])
    expect(onSaved).toHaveBeenCalledWith({ groupId: 'g-new', warning: false })
  })

  it('removes on retry anyone a failed create added and the admin has since taken off the list', async () => {
    const respond = groupBackend()
    let failBob = true
    const { harness, result, onSaved } = renderForm((request) => {
      const addsBob =
        request.method === 'POST' &&
        request.path === 'admin/groups/g-new/members' &&
        (request.body as { userId: string }).userId === 'user-2'
      if (failBob && addsBob) {
        failBob = false
        return { status: 500, body: { error: 'INTERNAL' } }
      }
      return respond(request)
    }, null)
    await flush()

    act(() => result.current.setName('Design'))
    act(() => result.current.setIsAdmin(true))
    act(() =>
      result.current.addMembers([
        { userId: 'user-1', label: 'Ada' },
        { userId: 'user-2', label: 'Bob' },
      ]),
    )
    act(() => result.current.save.mutate())
    await flush()
    expect(result.current.save.isError).toBe(true)

    harness.requests.length = 0
    act(() => result.current.removeMember('user-1'))
    act(() => result.current.setIsAdmin(false))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'POST', path: 'admin/groups/g-new/members', body: { userId: 'user-2' } },
      { method: 'DELETE', path: 'admin/groups/g-new/members/user-1' },
      { method: 'DELETE', path: 'admin/role-mappings/m-new' },
    ])
    expect(onSaved).toHaveBeenCalledWith({ groupId: 'g-new', warning: false })
  })

  it('removes the signed-in admin from the group after every other change, the admin mapping included', async () => {
    const self = makeMember({
      userId: 'admin-1',
      roles: [{ role: adminRole, from: 'local_group', groupId: 'g1', groupName: 'Ops' }],
    })
    const { harness, result } = renderForm(adminGroupBackend(undefined, self))
    await flush()

    act(() => result.current.removeMember('admin-1'))
    act(() => result.current.removeMember('user-1'))
    act(() => result.current.setIsAdmin(false))
    act(() => result.current.save.mutate())
    await flush()

    expect(changes(harness.requests)).toMatchObject([
      { method: 'DELETE', path: 'admin/groups/g1/members/user-1' },
      { method: 'DELETE', path: 'admin/role-mappings/m1' },
      { method: 'DELETE', path: 'admin/groups/g1/members/admin-1' },
    ])
  })

  it("asks first when the save takes the signed-in admin's own admin away", async () => {
    // The test session's admin is admin-1, an admin only through Ops.
    const self = makeMember({
      userId: 'admin-1',
      roles: [{ role: adminRole, from: 'local_group', groupId: 'g1', groupName: 'Ops' }],
    })
    const { result } = renderForm(adminGroupBackend(undefined, self))
    await flush()
    expect(result.current.isSelfDemoting).toBe(false)

    act(() => result.current.removeMember('admin-1'))
    expect(result.current.isSelfDemoting).toBe(true)
  })
})
